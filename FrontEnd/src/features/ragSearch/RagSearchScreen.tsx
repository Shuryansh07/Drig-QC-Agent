import { useState, type FormEvent } from "react";
import { PageShell } from "@/components/common/PageShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ApiError } from "@/lib/api-client";
import { useRagQuery } from "./api/mutations";

/**
 * A real, working test surface for the actual backend's RAG query endpoint —
 * not a mock. Type a question, hit the same POST /api/rag/query the curl/
 * Postman tests have been hitting all along, see the grounded answer + page
 * sources come back live.
 */
export default function RagSearchScreen() {
  const [customerId, setCustomerId] = useState("default");
  const [question, setQuestion] = useState("");
  const { mutate, data, error, isPending } = useRagQuery();

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!question.trim()) return;
    mutate({ customer_id: customerId.trim() || "default", question: question.trim() });
  };

  return (
    <PageShell
      header={
        <div className="px-5 py-4">
          <h1 className="text-title font-semibold tracking-tight">RAG search (test)</h1>
          <p className="text-xs text-muted-foreground mt-1">
            Calls the real backend directly — POST /api/rag/query.
          </p>
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="customer_id" className="text-xs text-muted-foreground">
            Customer ID
          </label>
          <Input
            id="customer_id"
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            placeholder="default"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="question" className="text-xs text-muted-foreground">
            Question
          </label>
          <Textarea
            id="question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="e.g. Where should the tracking unit be mounted?"
            rows={3}
            autoFocus
          />
        </div>

        <Button type="submit" disabled={isPending || !question.trim()}>
          {isPending ? "Asking…" : "Ask"}
        </Button>
      </form>

      {error ? (
        <Card className="border-destructive mt-6">
          <CardContent>
            <p className="text-body font-medium text-destructive">Request failed</p>
            <p className="text-xs text-muted-foreground mt-1">
              {error instanceof ApiError
                ? `${error.status} ${error.code}: ${error.message}`
                : error.message}
            </p>
          </CardContent>
        </Card>
      ) : null}

      {data ? (
        <Card className="mt-6">
          <CardContent className="flex flex-col gap-4">
            <div className="flex items-start justify-between gap-3">
              <p className="text-body whitespace-pre-wrap">{data.answer}</p>
              <Badge variant="outline" className="shrink-0 font-mono">
                {data.durationMs}ms
              </Badge>
            </div>

            {data.sources.length > 0 ? (
              <div className="flex flex-col gap-2">
                <span className="text-xs text-muted-foreground">Sources</span>
                <div className="flex flex-wrap gap-2">
                  {data.sources.map((s, i) => (
                    <Badge key={`${s.document_id}-${s.page_number}-${i}`} variant="secondary">
                      {s.page_number !== null ? `Page ${s.page_number}` : (s.section_path?.split(" > ").pop() ?? "Document")}
                      <span className="text-muted-foreground ml-1 font-mono text-[10px]">
                        {s.document_id.slice(0, 8)}
                      </span>
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </PageShell>
  );
}
