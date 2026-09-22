import { useCallback } from "react";
import { useParams } from "react-router";
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
import { EmptyState } from "@/components/common/EmptyState";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";

export default function ChatScreen() {
  const { sessionId = "" } = useParams();
  const dispatch = useAppDispatch();
  const online = useOnlineStatus();

  const draft = useAppSelector((s) => s.chat.draft);
  const streaming = useAppSelector((s) => s.chat.status);

  const { data: conversation } = useConversation(sessionId);
  const { send, cancel } = useChatStream(sessionId);
  const recordResolution = useRecordResolution(sessionId);

  const openEngineer = useCallback(
    () => dispatch(uiActions.handoffSheetToggled(true)),
    [dispatch],
  );

  const openCitation = useCallback(
    (chunkId: string) => dispatch(uiActions.citationOpened(chunkId)),
    [dispatch],
  );

  const turns = conversation?.turns ?? [];
  const busy = streaming === "thinking" || streaming === "streaming";

  return (
    <PageShell
      dock={
        <div className="space-y-3">
          <TranscriptPreview onSend={(text) => void send(text)} />
          <ChatComposer
            value={draft}
            disabled={busy}
            offline={!online}
            onChange={(value) => dispatch(chatActions.draftChanged(value))}
            onSend={() => void send(draft)}
          />
        </div>
      }
    >
      {turns.length === 0 && streaming === "idle" ? (
        <EmptyState
          title="What are you looking at?"
          body="Tell me the vehicle and what it's doing. Say it out loud or type it — either works."
        />
      ) : null}

      <div className="space-y-8">
        {turns.map((turn) => (
          <TurnView
            key={turn.turnId}
            turn={turn}
            onOpenCitation={openCitation}
            onAnswerClarify={(value) => void send(value)}
            onSkipClarify={() => void send("I don't know")}
            onRequestEngineer={openEngineer}
            onResolution={(resolution) =>
              recordResolution.mutate({ turnId: turn.turnId, resolution })
            }
          />
        ))}

        <StreamingTurnView
          onOpenCitation={openCitation}
          onAnswerClarify={(value) => void send(value)}
          onSkipClarify={() => void send("I don't know")}
          onRequestEngineer={openEngineer}
          onCancel={cancel}
        />
      </div>

      <SourceDrawer />
      <HandoffSheet onSubmit={() => {}} />
    </PageShell>
  );
}
