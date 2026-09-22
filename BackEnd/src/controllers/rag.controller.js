import { retrieveRelevantChunks } from "../services/ragRetrieval.service.js";
import { generateAnswer, streamAnswer, sourcesFromChunks, INSUFFICIENT_EVIDENCE_ANSWER } from "../services/answerGeneration.service.js";
import { recordGap } from "../db/gaps.js";
import { listLiveDocumentTitles } from "../db/documents.js";
import { getDeadlineMs } from "../db/settings.js";
import { logger } from "../utils/logger.js";

const HEARTBEAT_MS = 10_000;
const FALLBACK_DEADLINE_MS = 22_000;

/**
 * A refused question is not just an empty answer: it is recorded so
 * management can see what technicians keep asking that nothing documents
 * (Blueprint scenario D), and the technician is told what IS covered.
 * Neither step may break the refusal itself, so both are best-effort.
 */
const refuse = async ({ question, retrieval }) => {
  const { admission, embedding, candidateIds } = retrieval;
  logger.info(`[rag] refused (${admission.reason}, top similarity ${admission.topSimilarity.toFixed(3)}): "${question}"`);

  await recordGap({ queryText: question, queryEmbedding: embedding, retrievedIds: candidateIds, reason: "not_covered" }).catch((err) =>
    logger.error("[rag] failed to record knowledge gap", err)
  );
  const coveredTopics = await listLiveDocumentTitles().catch(() => []);

  return {
    coveredTopics,
    message: "I don't have documented guidance for that. I can hand this to an engineer with everything you've told me.",
  };
};

export const queryRag = async (req, res) => {
  const requestStart = Date.now();
  try {
    const { question } = req.body || {};

    if (!question || typeof question !== "string" || !question.trim()) {
      return res.status(400).json({ success: false, message: "question is required" });
    }

    logger.info(`[rag query] received: "${question}"`);

    const retrieval = await retrieveRelevantChunks({ question });
    logger.info(`[rag query] retrieved ${retrieval.chunks.length} chunk(s) (gate: ${retrieval.admission.reason})`);

    if (!retrieval.admission.admitted) {
      await refuse({ question, retrieval });
      return res.status(200).json({ answer: INSUFFICIENT_EVIDENCE_ANSWER, sources: [] });
    }

    const { answer, sources } = await generateAnswer({ question, chunks: retrieval.chunks });

    logger.info(`[rag query] TOTAL request time: ${Date.now() - requestStart}ms`);

    return res.status(200).json({ answer, sources });
  } catch (error) {
    logger.error("RAG query error", error);
    return res.status(500).json({
      success: false,
      message: "Failed to answer question",
      error: error.message,
    });
  }
};

/**
 * POST /api/rag/query/stream — Server-Sent Events. One JSON object per
 * `data:` line, in this order:
 *
 *   {type:"stage", stage:"retrieving"}                      immediately
 *   {type:"not_covered", notCovered:{...}}                  gate refused -> stream ends, no LLM call
 *   {type:"sources", sources:[{document_id, page_number}]}  as soon as retrieval finishes
 *   {type:"stage", stage:"generating"}
 *   {type:"delta", text}                                    repeated, as the model writes
 *   {type:"deadline_warning", elapsedMs}                    only if gate.deadline_ms passes first
 *   {type:"complete", answer, durationMs}                   the whole answer, then the stream ends
 *   {type:"error", code, message}                           anything that went wrong after headers
 *
 * The first byte goes out before retrieval starts, so a slow embedding or
 * database call shows up as "searching…" on the client instead of a blank wait.
 * Lines starting with ":" are heartbeats that keep proxies from closing an idle
 * connection.
 */
export const streamRagQuery = async (req, res) => {
  const requestStart = Date.now();
  const { question } = req.body || {};

  // Before headers: a bad request is still an ordinary JSON 400.
  if (!question || typeof question !== "string" || !question.trim()) {
    return res.status(400).json({ success: false, message: "question is required" });
  }

  const deadlineMs = await getDeadlineMs().catch(() => FALLBACK_DEADLINE_MS);

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // tell nginx-style proxies not to buffer the stream
  });
  res.flushHeaders();

  let closed = false;
  const abort = new AbortController();
  const send = (event) => {
    if (!closed) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const heartbeat = setInterval(() => {
    if (!closed) res.write(": ping\n\n");
  }, HEARTBEAT_MS);
  const deadline = setTimeout(() => send({ type: "deadline_warning", elapsedMs: Date.now() - requestStart }), deadlineMs);

  // Client went away (tab closed, Stop pressed): stop paying for the answer.
  res.on("close", () => {
    closed = true;
    abort.abort();
    clearInterval(heartbeat);
    clearTimeout(deadline);
  });

  try {
    logger.info(`[rag stream] received: "${question}"`);
    send({ type: "stage", stage: "retrieving" });

    const retrieval = await retrieveRelevantChunks({ question });
    if (closed) return;

    if (!retrieval.admission.admitted) {
      const notCovered = await refuse({ question, retrieval });
      send({ type: "not_covered", notCovered });
      return;
    }

    logger.info(`[rag stream] ${retrieval.chunks.length} chunk(s) admitted (${retrieval.admission.reason}) after ${Date.now() - requestStart}ms`);
    send({ type: "sources", sources: sourcesFromChunks(retrieval.chunks) });
    send({ type: "stage", stage: "generating" });

    let answer = "";
    let firstTokenLogged = false;
    for await (const delta of streamAnswer({ question, chunks: retrieval.chunks, signal: abort.signal })) {
      if (!firstTokenLogged) {
        firstTokenLogged = true;
        logger.info(`[rag stream] first token after ${Date.now() - requestStart}ms`);
      }
      answer += delta;
      send({ type: "delta", text: delta });
    }

    send({ type: "complete", answer: answer.trim() || INSUFFICIENT_EVIDENCE_ANSWER, durationMs: Date.now() - requestStart });
    logger.info(`[rag stream] TOTAL request time: ${Date.now() - requestStart}ms`);
  } catch (error) {
    if (closed) return; // the client left; nothing to tell them
    logger.error("RAG stream error", error);
    send({ type: "error", code: error.status ? `upstream_${error.status}` : "stream_failed", message: "The answer could not be completed." });
  } finally {
    clearInterval(heartbeat);
    clearTimeout(deadline);
    if (!closed) res.end();
  }
};
