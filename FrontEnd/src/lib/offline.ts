/**
 * Outbox persistence (§9). Questions typed without signal are queued, survive a
 * reload, and are sent on reconnect.
 *
 * Skeleton: storage and reconciliation are in place; the actual send is wired up
 * when `useChatStream` talks to a real endpoint.
 */

import type { OutboxEntry } from "@/features/outbox/outboxSlice";

const STORAGE_KEY = "drig.outbox.v1";

export function loadOutbox(): OutboxEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as OutboxEntry[]) : [];
  } catch {
    // Private mode, blocked site data, or a corrupt entry. An empty outbox is
    // the correct degraded state — never let this throw into render.
    return [];
  }
}

export function saveOutbox(entries: OutboxEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Quota or blocked storage. The in-memory queue still works for this session.
  }
}

export function clearOutbox(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing useful to do.
  }
}

/** True when the browser believes it can reach the network. Advisory only. */
export function isOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}
