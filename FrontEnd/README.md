# DRIG Tech Support — web

React 19 · Vite · TypeScript · Tailwind v4 · shadcn/ui (new-york) · Redux Toolkit · TanStack Query · PWA

Built to `Plan/FRONTEND_DESIGN.md`. This is the **setup and skeleton**: the stack
is wired, the design tokens are real, the folder structure is the one the plan
specifies, and every screen routes and renders. Component logic that needs a
backend is stubbed and marked `TODO` — `BackEnd/` is empty, so nothing here has
a live endpoint to talk to.

## Running it

```bash
corepack enable            # pnpm is pinned via packageManager
pnpm install
cp .env.example .env.local
pnpm dev
```

npm will hit `ERESOLVE` on the Radix packages and demand `--legacy-peer-deps` on
every install. pnpm, bun and yarn only warn. `packageManager` pins pnpm so this
does not become a per-developer decision.

| Script | Does |
|---|---|
| `pnpm dev` | Vite dev server, `/api` proxied to `VITE_API_PROXY` |
| `pnpm build` | Typecheck, bundle, generate the service worker |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `tsc -b` alone |
| `pnpm icons` | Regenerate `public/icons/*.png` from `icon.svg` |

## What is wired

- **Tailwind v4** via `@tailwindcss/vite`, single `@import "tailwindcss"`. Tokens
  in `src/styles/globals.css`.
- **shadcn/ui**, new-york, 21 primitives in `src/components/ui` — vendored, and
  linted as such.
- **Redux Toolkit** slices only, no RTK Query: `chat`, `voice`, `ui`, `outbox`.
- **TanStack Query** for everything server-owned, per the §3 boundary.
- **PWA** with `vite-plugin-pwa`; conversations and citations are runtime-cached
  so an answer already received stays readable off signal.
- **Router** with lazily loaded routes: `/s/:sessionId`, `/vehicle`, `/handoff`,
  `/engineer`, `/sign-in`.

## What is not

- No backend, so no request succeeds yet. No mock data is baked in — a mock that
  drifts from the real contract is worse than a clear failure.
- Voice captures audio and negotiates the mime type, but there is no endpoint to
  transcribe against.
- `SourceDrawer` renders the cached excerpt; the PDF/wiring-row/call views need
  the document service.
- Auth is a context shape with no sign-in behind it.

## Design decisions worth knowing

The plan's §1 constraints drive the layout, not aesthetics: 56px minimum touch
targets, primary actions in the bottom third, 17px body floor and 20px answer
steps, nothing hover-only.

Two choices the plan left open:

- **IBM Plex Sans**, self-hosted via `@fontsource` so it works with no signal.
  Chosen for a large x-height and unambiguous numerals — pin numbers, wire
  gauges and model years are read wrong at arm's length in a dark workshop.
- **Signal blue** for primary actions, **hi-vis amber** for "still working" and
  caution. Red is reserved for genuine safety steps inside an answer and nothing
  else. `ClarifyPrompt`, `NotCoveredCard` and `ConflictCard` are the system
  working correctly (§5), so they are styled neutrally — if "I don't have that
  documented" reads as a fault, technicians conclude the product is broken.

## Contracts

`src/types/contracts.ts` is **provisional**. Once `/contracts` exists, generate
`src/types/generated/` from the shared JSON Schemas and delete it. The generated
directory is git-ignored on purpose: a stale committed copy compiles cleanly
against a contract that no longer exists, and drift in the answer contract means
citations silently stop rendering.

## Before the voice phase ships

Test on the phones technicians actually carry, in week one. iOS records to
`audio/mp4`, not `audio/webm` — `pickMimeType()` negotiates it rather than
assuming. Microphone access in installed standalone mode has been historically
unreliable on iOS, so validate it installed, not in a Safari tab.
