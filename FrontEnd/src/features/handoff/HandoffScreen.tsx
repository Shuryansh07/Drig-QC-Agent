import { PageShell } from "@/components/common/PageShell";
import { EmptyState } from "@/components/common/EmptyState";

/** Skeleton. Shows a technician the state of a handoff they opened. */
export default function HandoffScreen() {
  return (
    <PageShell>
      <h1 className="text-title font-semibold tracking-tight">With an engineer</h1>
      <EmptyState
        title="Nothing open"
        body="When you ask an engineer for help, the conversation shows up here until they close it."
      />
    </PageShell>
  );
}
