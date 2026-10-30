import { useState } from "react";
import { Link } from "react-router";
import { ChevronLeft, ChevronRight, ExternalLink, LoaderCircle, MessageSquarePlus, Search } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { useUnansweredQuestions } from "../api/queries";
import { useAnswerUnanswered } from "../api/mutations";
import type { MissKind, UnansweredQuestion } from "../types";

const KINDS: { kind: MissKind; label: string; hint: string }[] = [
  { kind: "not_found", label: "Not found", hint: "Nothing in the knowledge base matched the question." },
  { kind: "no_answer", label: "No answer in the manuals", hint: "Related passages were found, but none of them answered it." },
  { kind: "not_resolved", label: "Marked not resolved", hint: "An answer was given, but the technician said it did not help." },
  { kind: "no_reply", label: "No reply", hint: "The answer failed or was cancelled before it finished." },
];

const LABEL: Record<MissKind, string> = Object.fromEntries(KINDS.map((k) => [k.kind, k.label])) as Record<MissKind, string>;

const errorMessage = (err: unknown): string =>
  err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Request failed";

/**
 * The admin writes the answer. The question is editable: a follow-up's rewritten question, or a typo,
 * is worth fixing first, since it is what new questions are matched against.
 */
function AnswerDialog({ item, open, onOpenChange }: { item: UnansweredQuestion; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [question, setQuestion] = useState(item.question || item.asked);
  const [answer, setAnswer] = useState("");
  const save = useAnswerUnanswered();
  const canSave = question.trim().length > 0 && answer.trim().length > 0 && !save.isPending;

  const submit = () =>
    save.mutate(
      { turnId: item.turn_id, question: question.trim(), answer: answer.trim() },
      {
        onSuccess: (result) => {
          toast.success(result.created ? "Answer saved to the FAQ" : "Updated the FAQ answer to this question");
          onOpenChange(false);
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );

  return (
    <Dialog open={open} onOpenChange={(next) => !save.isPending && onOpenChange(next)}>
      <DialogContent showCloseButton={!save.isPending} className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Answer this question</DialogTitle>
          <DialogDescription>
            Saved to the FAQ. When a technician asks this question again, or one worded very much like it, they get your answer as
            written.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor={`q-${item.turn_id}`} className="text-micro font-medium">
              Question
            </label>
            <Textarea id={`q-${item.turn_id}`} value={question} onChange={(e) => setQuestion(e.target.value)} rows={2} maxLength={1000} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`a-${item.turn_id}`} className="text-micro font-medium">
              Answer
            </label>
            <Textarea
              id={`a-${item.turn_id}`}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              rows={8}
              maxLength={8000}
              placeholder="Write the answer the technician should get, step by step where it helps."
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={save.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSave} onClick={submit}>
            {save.isPending ? <LoaderCircle className="animate-spin" /> : null}
            Save answer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function QuestionRow({ item }: { item: UnansweredQuestion }) {
  const [answering, setAnswering] = useState(false);
  // The typed text differs from the searched question after a follow-up was rewritten or a clarification picked.
  const showAsked = item.asked && item.asked.trim() !== item.question.trim();
  return (
    <li className="border-border bg-card space-y-2 rounded-lg border px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={item.kind === "not_found" ? "destructive" : item.kind === "no_reply" ? "outline" : "secondary"}>{LABEL[item.kind]}</Badge>
        <span className="text-micro text-muted-foreground">{new Date(item.created_at).toLocaleString()}</span>
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => setAnswering(true)}>
          <MessageSquarePlus />
          Answer
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link to={`/s/${item.session_id}`}>
            Open chat
            <ExternalLink />
          </Link>
        </Button>
      </div>
      <p className="text-body font-medium break-words">{item.question || item.asked || "(empty question)"}</p>
      {showAsked ? <p className="text-micro text-muted-foreground break-words">Typed: “{item.asked}”</p> : null}
      {item.reply ? (
        <details>
          <summary className="text-micro text-muted-foreground cursor-pointer">Assistant&apos;s reply</summary>
          <p className="text-micro text-muted-foreground mt-1 whitespace-pre-wrap break-words">{item.reply}</p>
        </details>
      ) : null}
      {/* Mounted only while open, so each opening starts from the question as asked. */}
      {answering ? <AnswerDialog item={item} open onOpenChange={setAnswering} /> : null}
    </li>
  );
}

/**
 * Questions technicians asked that the assistant did not answer, read from saved chat history.
 * The list is what's missing from the knowledge base: a manual to upload or a section to add.
 */
export function UnansweredPanel() {
  const [kind, setKind] = useState<MissKind | null>(null);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  const { data, isPending, error, refetch } = useUnansweredQuestions(page, debouncedSearch, kind);
  const questions = data?.questions;
  const totalPages = data?.total_pages ?? 1;
  const allCount = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : null;

  const changeKind = (next: MissKind | null) => {
    setKind(next);
    setPage(1);
  };
  const handleSearchChange = (value: string) => {
    setSearchInput(value);
    setPage(1);
  };

  const chip = (value: MissKind | null, label: string, count: number | null, hint?: string) => (
    <Button
      key={value ?? "all"}
      variant={kind === value ? "default" : "outline"}
      size="sm"
      title={hint}
      aria-pressed={kind === value}
      onClick={() => changeKind(value)}
    >
      {label}
      {count !== null ? <span className={cn("tabular-nums", kind === value ? "opacity-80" : "text-muted-foreground")}>{count}</span> : null}
    </Button>
  );

  return (
    <section aria-label="Unanswered questions" className="space-y-4">
      <p className="text-micro text-muted-foreground">
        Questions technicians asked that the assistant could not answer. Upload the missing manual, or write the answer yourself: it
        is saved to the FAQ and given the next time the question is asked.
      </p>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by reason">
          {chip(null, "All", allCount)}
          {KINDS.map((k) => chip(k.kind, k.label, data ? data.counts[k.kind] : null, k.hint))}
        </div>
        <div className="relative lg:w-72">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" aria-hidden />
          <Input
            type="search"
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search questions…"
            aria-label="Search unanswered questions"
            className="pl-9"
          />
        </div>
      </div>

      {isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : error ? (
        <div className="border-destructive rounded-xl border p-4" role="alert">
          <p className="text-body text-destructive font-medium">Couldn&apos;t load unanswered questions</p>
          <p className="text-micro text-muted-foreground mt-1">{errorMessage(error)}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      ) : !questions || questions.length === 0 ? (
        debouncedSearch || kind ? (
          <EmptyState
            title="No matches"
            body="No unanswered question matches this filter."
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  handleSearchChange("");
                  changeKind(null);
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState title="Every question was answered" body="Questions the assistant can't answer will show up here." />
        )
      ) : (
        <>
          <ul className="space-y-3">
            {questions.map((q) => (
              <QuestionRow key={q.turn_id} item={q} />
            ))}
          </ul>

          {totalPages > 1 ? (
            <div className="flex items-center justify-between pt-1">
              <p className="text-micro text-muted-foreground">
                Page {page} of {totalPages}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(page - 1)}>
                  <ChevronLeft />
                  Previous
                </Button>
                <Button variant="outline" size="sm" disabled={page === totalPages} onClick={() => setPage(page + 1)}>
                  Next
                  <ChevronRight />
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
