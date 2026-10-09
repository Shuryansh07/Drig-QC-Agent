import { useCallback, useEffect, useRef } from "react";
import { useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useAppDispatch, useAppSelector } from "@/app/hooks";
import { chatActions } from "@/features/chat/chatSlice";
import { uiActions } from "@/features/ui/uiSlice";
import { useChatStream } from "@/features/chat/hooks/useChatStream";
import { useConversation } from "@/features/chat/api/queries";
import { useRecordResolution } from "@/features/chat/api/mutations";
import { TurnView } from "@/features/chat/components/TurnView";
import { StreamingTurnView } from "@/features/chat/components/StreamingTurnView";
import { ChatComposer } from "@/features/chat/components/ChatComposer";
import { TranscriptPreview } from "@/features/voice/components/TranscriptPreview";
import { SourceDrawer } from "@/features/citations/components/SourceDrawer";
import { HandoffSheet } from "@/features/handoff/components/HandoffSheet";
import { PageShell } from "@/components/common/PageShell";
import { Button } from "@/components/ui/button";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { apiFetch } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-client";
import type { Citation } from "@/types/contracts";

const SUGGESTIONS = [
  "Where should the tracking unit be mounted?",
  "Which wire is the ignition wire?",
  "The unit won't power on after install",
];

export default function ChatScreen() {
  const { sessionId = "" } = useParams();
  const dispatch = useAppDispatch();
  const queryClient = useQueryClient();
  const online = useOnlineStatus();

  const draft = useAppSelector((s) => s.chat.draft);
  const streaming = useAppSelector((s) => s.chat.status);
  // Only to re-run the auto-scroll effect as the answer grows — not rendered here,
  // StreamingTurnView reads the full chat slice itself for the actual content.
  const partialText = useAppSelector((s) => s.chat.partialText);
  const stepCount = useAppSelector((s) => s.chat.steps.length);

  const { data: conversation } = useConversation(sessionId);
  const { send, cancel } = useChatStream(sessionId);
  const recordResolution = useRecordResolution(sessionId);

  const openEngineer = useCallback(
    () => dispatch(uiActions.handoffSheetToggled(true)),
    [dispatch],
  );

  // A citation backed by a diagram/photo opens straight to it in a new tab — the
  // drawer is only for the text-only case, which has nothing else to show. The
  // tab opens blank synchronously (inside the click) so browsers don't treat the
  // post-fetch navigation as a blocked popup.
  const openCitation = useCallback(
    (chunkId: string) => {
      // No noopener/noreferrer: those make window.open() return null, and the
      // reference is required to navigate this tab once the fetch below resolves.
      const tab = window.open("", "_blank");

      void queryClient
        .fetchQuery({
          queryKey: queryKeys.citation(chunkId),
          staleTime: 60 * 60 * 1000,
          queryFn: () => apiFetch<Citation>(`/citations/${chunkId}`),
        })
        .then((citation) => {
          if (citation.imageUrl && tab) {
            tab.location.href = citation.imageUrl;
          } else {
            tab?.close();
            dispatch(uiActions.citationOpened(chunkId));
          }
        })
        .catch(() => {
          tab?.close();
          dispatch(uiActions.citationOpened(chunkId));
        });
    },
    [dispatch, queryClient],
  );

  const turns = conversation?.turns ?? [];

  // The technician picked an option on a clarification: ask the question that
  // preceded it again, with their pick, instead of sending the pick as a question of its own.
  const answerClarify = (clarifyTurnId: string | null, value: string) => {
    const upTo = clarifyTurnId ? turns.findIndex((t) => t.turnId === clarifyTurnId) : turns.length;
    const original = turns.slice(0, upTo < 0 ? turns.length : upTo).reverse().find((t) => t.role === "technician");
    void send(value, original ? { clarification: { originalQuestion: original.text, value, skipped: false } } : undefined);
  };
  const busy = streaming === "thinking" || streaming === "streaming";

  // Follows the answer down as it streams: this re-runs on the question being sent
  // (status -> "thinking") and again on every batch of tokens/steps that arrives
  // after that, so the newest text stays in view instead of growing off-screen below
  // the fold. Settles on its own once streaming ends — nothing left to re-trigger it.
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (streaming === "thinking" || streaming === "streaming") {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [streaming, partialText, stepCount]);

  return (
    <PageShell
      dock={
        <div className="space-y-3">
          <TranscriptPreview onSend={(text) => void send(text)} />
          <ChatComposer
            value={draft}
            busy={busy}
            offline={!online}
            onChange={(value) => dispatch(chatActions.draftChanged(value))}
            onSend={() => void send(draft)}
            onStop={cancel}
          />
        </div>
      }
    >
      {turns.length === 0 && streaming === "idle" ? (
        <div className="flex flex-col items-center gap-8 pt-[12vh] text-center">
          <div className="space-y-2">
            <h1 className="text-title font-semibold tracking-tight text-balance">What can I help with?</h1>
            <p className="text-muted-foreground text-body mx-auto max-w-[42ch]">
              Tell me the vehicle and what it's doing. Type it or say it out loud.
            </p>
          </div>

          <div className="flex flex-wrap justify-center gap-2">
            {SUGGESTIONS.map((suggestion) => (
              <Button
                key={suggestion}
                variant="outline"
                onClick={() => void send(suggestion)}
                className="h-auto rounded-full px-4 py-2 text-base font-normal whitespace-normal"
              >
                {suggestion}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="space-y-8">
        {turns.map((turn) => (
          <TurnView
            key={turn.turnId}
            turn={turn}
            onOpenCitation={openCitation}
            onAnswerClarify={(value) => answerClarify(turn.turnId, value)}
            onRequestEngineer={openEngineer}
            onResolution={(resolution) =>
              recordResolution.mutate({ turnId: turn.turnId, resolution })
            }
          />
        ))}

        <StreamingTurnView
          onOpenCitation={openCitation}
          onAnswerClarify={(value) => answerClarify(null, value)}
          onRequestEngineer={openEngineer}
        />

        {/* Zero-height: scrollIntoView'd rather than rendered, just marks "the bottom" to follow. */}
        <div ref={bottomRef} />
      </div>

      <SourceDrawer />
      <HandoffSheet onSubmit={() => {}} />
    </PageShell>
  );
}
