import type { ServerEvent } from "@/types/contracts";

/**
 * Parses one SSE frame — the text between a pair of blank lines — into its
 * JSON payload. Returns null for comments, heartbeats and malformed data, so a
 * stray or future line never crashes a stream mid-answer.
 */
export function parseSSEData(raw: string): unknown {
  const dataLines: string[] = [];

  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue; // heartbeat comment
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }

  if (dataLines.length === 0) return null;

  try {
    return JSON.parse(dataLines.join("\n")) as unknown;
  } catch {
    return null;
  }
}

/**
 * Parses one SSE frame into a typed server event. Returns null for comments,
 * heartbeats and anything unrecognised so an unknown future event type never
 * crashes a stream mid-answer.
 */
export function parseSSE(raw: string): ServerEvent | null {
  const parsed = parseSSEData(raw);
  return isServerEvent(parsed) ? parsed : null;
}

const KNOWN_TYPES = new Set([
  "frame",
  "clarify",
  "step",
  "citation",
  "not_covered",
  "conflict",
  "deadline_warning",
  "done",
  "error",
]);

function isServerEvent(value: unknown): value is ServerEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string" &&
    KNOWN_TYPES.has((value as { type: string }).type)
  );
}

/**
 * Splits a running buffer into complete SSE frames, returning the frames and
 * whatever partial text is left over for the next chunk.
 */
export function drainFrames(buffer: string): { frames: string[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  return { frames: parts.filter((p) => p.trim().length > 0), rest };
}

/**
 * Yields each complete SSE frame from a streaming fetch response as it
 * arrives. Handles frames split across network chunks and CRLF line endings.
 */
export async function* readSSEFrames(response: Response): AsyncGenerator<string> {
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      const { frames, rest } = drainFrames(buffer);
      buffer = rest;
      yield* frames;
    }
    // A final frame with no trailing blank line still counts.
    buffer += decoder.decode();
    if (buffer.trim().length > 0) yield buffer;
  } finally {
    reader.releaseLock();
  }
}
