import type { ServerEvent } from "@/types/contracts";

/**
 * Parses one SSE frame — the text between a pair of blank lines — into a typed
 * server event. Returns null for comments, heartbeats and anything unrecognised
 * so an unknown future event type never crashes a stream mid-answer.
 */
export function parseSSE(raw: string): ServerEvent | null {
  const dataLines: string[] = [];

  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue; // heartbeat comment
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }

  if (dataLines.length === 0) return null;

  try {
    const parsed = JSON.parse(dataLines.join("\n")) as unknown;
    if (isServerEvent(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
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
