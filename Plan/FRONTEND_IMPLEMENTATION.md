# Frontend — Implementation Reference

This replaces `FRONTEND_DESIGN.md`. That file designed a much larger planned
system (SSE streaming, session frames, multi-gate answer states, a
`/conversations/:id` history API) — a real UI skeleton exists for it, but
**no backend was ever built to match that contract**. This document describes
what's actually wired to the real backend today, and draws a clear line
around what's still unconnected scaffolding.

---

## 1. What's real vs. what's scaffolding

| Screen / feature | Status |
|---|---|
| `/search` — `RagSearchScreen` | **Real.** Calls the actual `POST /api/rag/query` directly. Built specifically as an honest test surface. |
| `/` — `ChatScreen` (mic button, composer, chat bubbles) | **Real**, as of this session. Originally called a `/chat` SSE endpoint that never existed (`404`s). `useChatStream.ts` was rewritten to call the same real `POST /api/rag/query` and adapt its one-shot response into the existing Redux/TanStack-Query event shapes, so `TurnView`/`StreamingTurnView`/`AnswerSteps`/citation chips render unchanged. |
| `SourceDrawer` (tapping a citation chip) | **Still scaffolding.** Calls `useCitation()` → a `/citations/:chunkId` endpoint that doesn't exist. Degrades gracefully ("This source needs a connection...") rather than crashing, but doesn't show real excerpt content. Would need a new backend endpoint to make real. |
| `/vehicle`, `/handoff`, `/engineer`, `/sign-in` | Untouched scaffolding — no real backend exists for any of these; out of scope for the RAG work. |
| Document **upload** UI | **Does not exist.** Every upload this session was done via curl/Postman directly against `POST /api/documents/upload`. There is no frontend page for uploading a PDF. |

---

## 2. `/search` — the direct test page

`src/features/ragSearch/`
- `RagSearchScreen.tsx` — customer_id input, question textarea, submit, renders `answer` + `sources` as page-number badges + a response-time badge (`Xms`, measured client-side around the actual fetch).
- `api/mutations.ts` — `useRagQuery()`, a `useMutation` wrapping `apiFetch("/rag/query", ...)`. Returns `{answer, sources, durationMs}`.
- `types.ts` — local types matching the *actual* backend contract (`RagQueryRequest`/`RagQueryResponse`), deliberately separate from `src/types/contracts.ts` (which describes the unbuilt future system).

This is the fastest way to manually test a real query without any of the chat UI's extra machinery.

---

## 3. `/` — the main chat screen, now real

`src/features/chat/hooks/useChatStream.ts` was rewritten. What it does now:

1. `send(text)` pushes a "technician" turn into the query-cache-backed conversation immediately.
2. `performance.now()` timestamp taken.
3. `POST /api/rag/query` with `{customer_id: "default", question: text}` — **not streamed**, one response.
4. The single `{answer, sources}` response is adapted into the existing event vocabulary:
   - one `AnswerStep` (`n: 1`) containing the full answer text — **not** split into fake numbered steps, since the backend returns prose, not a real sequence
   - one `Citation` per unique `{document_id, page_number}` in `sources`
   - a `Turn` with `gateOutcome: "answered"`, `durationMs` attached
5. Dispatches `step` → `citation`(s) → `done` through `chatSlice`, then appends the finished turn to the TanStack Query cache.

**Fields the real backend has no data for are never faked**: `frame`, `clarify`, `notCovered`, `conflict`, `deadlineWarning` are simply never dispatched. `SessionHeader` correctly falls back to "No vehicle set" rather than showing an invented vehicle.

`customer_id` is hardcoded to `"default"` in `useChatStream.ts` — there's no real auth/tenant-selection UI yet (`AuthProvider` is a stub, `signedIn: false` always).

`features/chat/api/queries.ts` → `useConversation()`: the `GET /conversations/:id` fetch is now `enabled: false` (never actually fires — that endpoint doesn't exist). Turn history lives entirely in the TanStack Query cache, seeded directly by `useChatStream.ts` via `queryClient.setQueryData()`. This was a real fix — the query used to fire, always 404, on every load.

`Turn` (in `src/types/contracts.ts`) gained one new optional field: `durationMs?: number` — populated for agent turns, rendered in `TurnView.tsx` as "Answered in Xms".

---

## 4. Shared plumbing

**`src/lib/api-client.ts`** — `apiFetch()`, the one function every real call goes through. Logs every request automatically (method, URL, status, duration) via `src/lib/logger.ts` — mirrors the backend's `[TIMESTAMP] [LEVEL] message` log format for console-to-console consistency when debugging a request end to end. This is browser-console output only — there's no server-side file for it, unlike the backend's `logs/app.log`.

**`vite.config.ts`** — dev proxy: `/api/*` → `VITE_API_PROXY` (real backend, `http://localhost:5000`). **Real bug found and fixed here**: the config read `process.env.VITE_API_PROXY` directly, but Vite never loads `.env.local` into the config file's own Node process (only into client code via `import.meta.env`) — so the proxy silently always fell back to the hardcoded `localhost:8080` default regardless of `.env.local`. Fixed with `loadEnv()`.

**`.env.local`** (gitignored, not committed) — `VITE_API_PROXY=http://localhost:5000`.

---

## 5. How to run it

```bash
# terminal 1 — backend API
cd BackEnd && npm run dev

# terminal 2 — backend worker (required — uploads only process if this is running)
cd BackEnd && npm run dev:worker

# terminal 3 — frontend
cd FrontEnd && npm run dev
```

Open `http://localhost:5173/search` for the direct test page, or `http://localhost:5173/` for the full chat UI (both hit the same real backend). Document upload still has to go through curl/Postman/the backend directly — there's no upload UI yet.

---

## 6. What would need to be built next, if wanted

- An upload UI (drag-and-drop or file picker → `POST /api/documents/upload` → poll `GET /api/documents/:id/status` for progress)
- A real `SourceDrawer` backend (`GET /citations/:chunkId` or equivalent, returning the actual chunk excerpt + page reference) so tapping a citation shows real content instead of the graceful-degradation placeholder
- A real `customer_id` source (auth/tenant selection) instead of the hardcoded `"default"`
