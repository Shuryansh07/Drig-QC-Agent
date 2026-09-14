# Frontend Design — DRIG QC Support Agent

React 19 · Vite · TypeScript · Tailwind v4 · shadcn/ui · Redux Toolkit · TanStack Query

---

## 1. Design context

This is not a desktop chat app that happens to work on mobile. The primary user is a technician standing at a vehicle, holding a phone in one hand with a trim panel in the other, possibly wearing gloves, in a workshop or in direct sunlight, on patchy signal.

Every layout decision below follows from that, not from aesthetics.

| Condition | Consequence |
|---|---|
| Gloves | Minimum 56px touch targets. No small icon buttons |
| One hand | Primary actions in the bottom third, within thumb reach |
| Sunlight and dark workshops | High contrast, no mid-grey text on white, no thin weights |
| Screen at arm's length | 17px body minimum, 20px for answer steps |
| Patchy signal | Answers already received must remain readable offline |
| No hover | Nothing may be hover-only. Tooltips are tap-to-reveal |
| Dirty screen | Generous spacing; mis-taps are expensive when a step is a safety step |

---

## 2. Stack and setup

React 19 and Tailwind v4 are both fully supported by shadcn/ui. Four things changed with that release and they affect how you write components:

- `forwardRef` has been removed from the primitives and the types adjusted — in React 19 `ref` is an ordinary prop.
- Every primitive now carries a `data-slot` attribute, which is the intended styling hook.
- The `toast` component is deprecated in favour of `sonner`.
- The `default` style is deprecated; new projects use `new-york`. HSL colours are now OKLCH.

```bash
pnpm create vite@latest drig-agent-web -- --template react-ts
cd drig-agent-web
pnpm add tailwindcss @tailwindcss/vite
pnpm dlx shadcn@latest init
```

**Use pnpm, bun or yarn.** npm will hit `ERESOLVE` peer-dependency errors on Radix packages and require `--legacy-peer-deps` on every install. The other three only emit a silent warning. This is worth enforcing in the repo rather than leaving to each developer.

Tailwind v4 drops the three `@tailwind` directives for a single import:

```css
/* src/styles/globals.css */
@import "tailwindcss";
@import "tw-animate-css";
@custom-variant dark (&:is(.dark *));
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: { name: "DRIG Tech Support", short_name: "DRIG", display: "standalone" },
      workbox: { navigateFallback: "index.html" },
    }),
  ],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
});
```

---

## 3. State management — the boundary that matters

Redux Toolkit and TanStack Query overlap, and the common failure is copying server data into Redux and then maintaining two versions of the truth that drift. The rule here is simple.

> **TanStack Query owns anything that came from the server and could be refetched.**
> **Redux owns anything that exists only in this browser and would be lost on refresh anyway.**

| State | Owner | Why |
|---|---|---|
| Conversation list, past turns | TanStack Query | Server-owned, refetchable, cacheable |
| Citation document metadata | TanStack Query | Fetched on demand, cached by id |
| Engineer handoff queue | TanStack Query | Polled, server truth |
| Vehicle lookup results | TanStack Query | Server truth, keyed by make/model/year |
| Draft input text | Redux | Browser-only |
| Voice recorder state | Redux | Device state — idle, recording, transcribing |
| Streaming answer buffer | Redux | See below |
| Active clarifying question | Redux | Interaction state, not a resource |
| Offline queue of unsent messages | Redux, persisted | Survives reload, has no server representation yet |
| UI: sheet open, active citation | Redux | Ephemeral |

### The streaming answer fits neither

A token stream isn't a query result — it can't be refetched, and it arrives incrementally rather than resolving once. It also isn't purely client state, since it originates on the server.

The resolution: **Redux holds the in-flight buffer; on completion the finished turn is written into the TanStack cache and the buffer is cleared.**

```ts
// features/chat/chatSlice.ts
interface StreamingTurn {
  turnId: string;
  status: "idle" | "thinking" | "streaming" | "validating" | "done" | "refused" | "error";
  steps: Array<{ n: number; text: string; sourceChunkIds: string[] }>;
  partialText: string;
  gateOutcome: "answered" | "clarify" | "not_covered" | "conflict" | null;
}
```

```ts
// on stream completion
queryClient.setQueryData(["conversation", sessionId], (prev) => appendTurn(prev, finishedTurn));
dispatch(chatActions.clearStream());
```

One source of truth at rest, one buffer in motion. Nothing is duplicated for longer than a stream lasts.

### Configuration

```ts
// app/store.ts
export const store = configureStore({
  reducer: { chat: chatReducer, voice: voiceReducer, ui: uiReducer, outbox: outboxReducer },
});
export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
```

```ts
// lib/query-client.ts
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (count, err) => !isAuthError(err) && count < 2,
      refetchOnWindowFocus: false,   // a technician switching apps shouldn't trigger refetch storms
    },
  },
});
```

**No RTK Query.** It would duplicate TanStack Query. Redux here is slices only.

---

## 4. The streaming hook

Not `useQuery`. `EventSource` can't attach an auth header, so this uses `fetch` with a readable stream.

```ts
// features/chat/hooks/useChatStream.ts
export function useChatStream(sessionId: string) {
  const dispatch = useAppDispatch();
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(async (text: string, frame?: Partial<QueryFrame>) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    dispatch(chatActions.streamStarted());

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await getToken()}` },
      body: JSON.stringify({ sessionId, text, frame }),
      signal: ctrl.signal,
    });

    if (!res.body) throw new Error("no stream");
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += value;
      const events = buf.split("\n\n");
      buf = events.pop() ?? "";
      for (const e of events) dispatch(handleServerEvent(parseSSE(e)));
    }
  }, [sessionId, dispatch]);

  return { send, cancel: () => abortRef.current?.abort() };
}
```

**Server event types the UI must handle:** `frame`, `clarify`, `step`, `citation`, `not_covered`, `conflict`, `deadline_warning`, `done`, `error`.

`deadline_warning` fires at the 22-second internal deadline and renders "still working — or shall I get an engineer?" rather than letting the stream die silently.

---

## 5. Component architecture

### shadcn primitives to install

```bash
pnpm dlx shadcn@latest add button card sheet drawer dialog badge \
  separator skeleton scroll-area alert avatar input textarea \
  select command popover tooltip sonner tabs progress toggle
```

`drawer` over `dialog` for citations — bottom sheets are reachable one-handed. `sonner` rather than the deprecated `toast`.

### Custom components — the ones that carry the product

| Component | Responsibility |
|---|---|
| `AnswerSteps` | Renders numbered steps at 20px with generous spacing. Each step shows its citation chip inline. This is the most important component in the app |
| `CitationChip` | Tap target opening the source drawer. Shows document name and page, or sheet row, or call timestamp |
| `SourceDrawer` | Bottom sheet rendering the PDF at the cited page, the wiring row, or the call card with audio |
| `ClarifyPrompt` | A first-class state, not an error. One question, large tappable options drawn from the actual distinguishing values returned by retrieval |
| `NotCoveredCard` | States what *is* covered so the technician learns the boundary, then offers handoff. Neutral styling, never red |
| `ConflictCard` | Two sources side by side when they disagree, with handoff. Never picks one |
| `PushToTalkButton` | Large, bottom-centre, hold-to-record. Waveform while recording, transcript preview before send |
| `ResolutionBar` | Resolved / partly / not resolved, one tap, at the end of every turn |
| `OfflineBanner` | Signals cached-only mode |

### Three states that are features, not failures

`ClarifyPrompt`, `NotCoveredCard` and `ConflictCard` are the system working correctly. Style them neutrally. If "I don't have that documented" is rendered in error red, technicians read the product as broken and stop using it — which is the exact outcome the seven gates exist to avoid.

---

## 6. Design tokens

```css
@theme {
  --font-size-body: 1.0625rem;      /* 17px floor */
  --font-size-step: 1.25rem;        /* 20px answer steps */
  --spacing-touch: 3.5rem;          /* 56px minimum target */
  --color-answer-fg: oklch(0.22 0 0);
  --color-muted-fg: oklch(0.45 0 0);   /* not lighter — sunlight readability */
  --color-warn-bg: oklch(0.96 0.05 85);
}
```

Test contrast at maximum screen brightness outdoors, not on a desk monitor. The muted foreground token is deliberately darker than shadcn's default for this reason.

---

## 7. Folder structure

Feature-first, not type-first. At this size, grouping by domain beats grouping by file kind.

```
drig-agent-web/
├── .env.example
├── .gitignore
├── .nvmrc
├── components.json                  # shadcn config — do not hand-edit
├── eslint.config.js
├── index.html
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── tsconfig.app.json
├── vite.config.ts
├── public/
│   ├── icons/
│   └── manifest.webmanifest
└── src/
    ├── main.tsx
    ├── App.tsx
    │
    ├── app/                         # wiring, not features
    │   ├── store.ts
    │   ├── hooks.ts                 # typed useAppDispatch / useAppSelector
    │   ├── providers.tsx            # Query, Redux, Auth, Theme
    │   └── router.tsx
    │
    ├── components/
    │   ├── ui/                      # shadcn generated — treat as vendored
    │   └── common/                  # ErrorBoundary, PageShell, OfflineBanner
    │
    ├── features/
    │   ├── chat/
    │   │   ├── components/          # AnswerSteps, ClarifyPrompt, NotCoveredCard...
    │   │   ├── hooks/               # useChatStream, useConversation
    │   │   ├── api/                 # queries + mutations
    │   │   ├── chatSlice.ts
    │   │   └── types.ts
    │   ├── voice/
    │   │   ├── components/          # PushToTalkButton, TranscriptPreview
    │   │   ├── hooks/               # useRecorder, useTTSPlayback
    │   │   └── voiceSlice.ts
    │   ├── citations/
    │   ├── vehicle/                 # resolver UI, alias handling
    │   ├── handoff/
    │   ├── engineer/                # queue, review, closure
    │   └── auth/
    │
    ├── lib/
    │   ├── api-client.ts
    │   ├── sse.ts                   # SSE frame parser
    │   ├── query-client.ts
    │   ├── offline.ts               # outbox + cache reconciliation
    │   └── utils.ts                 # cn()
    │
    ├── types/
    │   └── generated/               # from /contracts — never hand-written
    │
    ├── hooks/                       # cross-feature only
    └── styles/
        └── globals.css
```

**`types/generated/` is generated from the shared `/contracts` JSON Schemas.** The frame and answer shapes are the same objects the backend gates validate. Hand-writing them on the frontend guarantees eventual drift, and drift in the answer contract means citations silently stop rendering.

---

## 8. `.gitignore`

```gitignore
# dependencies
node_modules/
.pnp
.pnp.js
.yarn/*
!.yarn/patches
!.yarn/releases
!.yarn/plugins
!.yarn/versions

# build
dist/
dist-ssr/
build/
*.local

# environment — never commit
.env
.env.*
!.env.example

# generated types — regenerated from /contracts
src/types/generated/

# PWA build artifacts
dev-dist/
public/sw.js
public/workbox-*.js
public/registerSW.js

# testing
coverage/
.nyc_output/
playwright-report/
test-results/
/blob-report/
/playwright/.cache/

# editors
.vscode/*
!.vscode/extensions.json
!.vscode/settings.json
.idea/
*.swp
*.swo
*.suo
*.ntvs*
*.njsproj
*.sln

# OS
.DS_Store
Thumbs.db
desktop.ini

# logs
logs/
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*
lerna-debug.log*

# caches
.eslintcache
.cache/
.parcel-cache/
.vite/
*.tsbuildinfo

# misc
.turbo/
.vercel/
```

Two lines worth noting. `.env.*` with a `!.env.example` exception stops the standard leak of `.env.local` containing a real key. And `src/types/generated/` is ignored because a stale committed copy is worse than no copy — it compiles cleanly against a contract that no longer exists.

---

## 9. Offline behaviour

| Scenario | Behaviour |
|---|---|
| Online | Normal |
| Signal lost, answer already received | Fully readable from cache, including cited text excerpt |
| Signal lost, question typed | Queued in the Redux outbox, persisted, sent on reconnect |
| Signal lost, citation not yet opened | Grey chip, "available when back online" |
| App reopened offline | Last 20 turns readable |

The service worker caches the API responses for recent conversations, not just the shell. A technician who lost signal after receiving an answer must still be able to read step 4.

---

## 10. Accessibility and testing

Radix gives keyboard and screen-reader behaviour. Beyond that:

- Every interactive element has a visible focus ring — technicians do use Bluetooth keyboards on bench work.
- Streaming answers use `aria-live="polite"`, not `assertive`, so a screen reader isn't interrupted mid-step.
- Voice states are announced, not just animated.

Test on the actual phones technicians carry, in the first week of the voice phase. iOS records to `audio/mp4`, not `audio/webm` — hardcode webm and voice fails silently on every iPhone. Microphone access in installed standalone mode has been historically unreliable on iOS, so validate it installed, not just in a Safari tab.
