import { getConversation, setResolution, isUuid, listUnanswered, markTurnAnswered } from "../db/chat.js";
import { recordResolution, recordAdminAnswer } from "../services/faq.service.js";
import * as storage from "../services/storage.service.js";
import { signUrl, BUCKET_IDS } from "../services/wiring/wiringBuckets.js";
import { logger } from "../utils/logger.js";

const RESOLUTIONS = new Set(["resolved", "partly", "not_resolved"]);

/** A saved turn as the browser renders it. Evidence images are re-signed: a stored link would have expired. */
const toWire = async (turn) => {
  const json = turn.turnJson ?? {};
  const images = await Promise.all(
    (json.images ?? []).map(async (img) => {
      try {
        // A wiring answer's photo names its bucket (DRIG wiring guide or Wiresheet); a manual figure is in the KB bucket.
        if (img.bucket && BUCKET_IDS.has(img.bucket) && img.key) {
          const url = await signUrl(img.bucket, img.key);
          const href = img.hrefKey && img.hrefKey !== img.key ? await signUrl(img.bucket, img.hrefKey, { downloadName: img.downloadName }) : url;
          return { label: img.label, document_id: null, page: null, url, href };
        }
        return { label: img.label, document_id: img.docId, page: img.page, url: await storage.getPresignedUrl(img.s3Key) };
      } catch (err) {
        logger.warn(`[chat] could not sign evidence image ${img.s3Key ?? img.key}: ${err.message}`);
        return null;
      }
    })
  );
  return {
    turn_id: turn.turnId,
    role: turn.role,
    text: turn.text,
    gate_outcome: turn.gateOutcome,
    resolution: turn.resolution,
    created_at: turn.createdAt.toISOString(),
    sources: json.sources ?? [],
    images: images.filter(Boolean),
    clarify: json.clarify ?? null,
    not_covered: json.notCovered ?? null,
    verified: json.verified ?? null,
    duration_ms: json.durationMs ?? null,
  };
};

/** GET /api/conversations/:sessionId — the saved chat (empty for a session with no messages yet). */
export const getConversationController = async (req, res) => {
  const { sessionId } = req.params;
  if (!isUuid(sessionId)) return res.status(400).json({ success: false, message: "sessionId must be a uuid" });
  try {
    const turns = await getConversation(sessionId);
    return res.status(200).json({ session_id: sessionId, turns: await Promise.all(turns.map(toWire)) });
  } catch (error) {
    logger.error("[chat] could not load conversation", error);
    return res.status(500).json({ success: false, message: "Could not load the conversation" });
  }
};

/**
 * POST /api/conversations/:sessionId/turns/:turnId/resolution { resolution }
 * Saves the rating. "resolved" also puts the question into the FAQ.
 */
export const recordResolutionController = async (req, res) => {
  const { sessionId, turnId } = req.params;
  const { resolution } = req.body || {};
  if (!isUuid(sessionId) || !isUuid(turnId)) return res.status(400).json({ success: false, message: "sessionId and turnId must be uuids" });
  if (!RESOLUTIONS.has(resolution)) return res.status(400).json({ success: false, message: "resolution must be resolved, partly or not_resolved" });

  try {
    const turn = await setResolution(sessionId, turnId, resolution);
    if (!turn) return res.status(404).json({ success: false, message: "That answer is not in this conversation" });

    // The rating is saved either way; a failure in the FAQ step must not undo it.
    const faq = await recordResolution({ turn, resolution }).catch((err) => {
      logger.error("[faq] could not update the FAQ", err);
      return { faq: "error" };
    });
    return res.status(200).json({ ok: true, ...faq });
  } catch (error) {
    logger.error("[chat] could not record resolution", error);
    return res.status(500).json({ success: false, message: "Could not save the rating" });
  }
};

const MISS_KINDS = new Set(["not_found", "no_answer", "not_resolved", "no_reply"]);
const MAX_PAGE_SIZE = 100;

/**
 * GET /api/conversations/unanswered?kind=&q=&page=&page_size= — for the admin panel: the questions
 * technicians asked that got no answer, so the missing manual (or section) can be added.
 */
export const listUnansweredController = async (req, res) => {
  const kind = MISS_KINDS.has(req.query.kind) ? req.query.kind : null;
  const search = typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim().slice(0, 200) : null;
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(req.query.page_size, 10) || 20));
  try {
    const { items, total, counts } = await listUnanswered({ kind, search, limit: pageSize, offset: (page - 1) * pageSize });
    return res.status(200).json({
      questions: items.map((q) => ({
        turn_id: q.turnId,
        session_id: q.sessionId,
        kind: q.kind,
        question: q.question,
        asked: q.asked,
        reply: q.reply,
        created_at: q.createdAt.toISOString(),
      })),
      counts,
      page,
      page_size: pageSize,
      total,
      total_pages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (error) {
    logger.error("[chat] could not list unanswered questions", error);
    return res.status(500).json({ success: false, message: "Could not load the unanswered questions" });
  }
};

const MAX_QUESTION_CHARS = 1000;
const MAX_ANSWER_CHARS = 8000;

/**
 * POST /api/conversations/unanswered/:turnId/answer { question, answer } — an admin answers a question
 * from the list. Saved to the FAQ with the question embedded; the turn then leaves the list.
 */
export const answerUnansweredController = async (req, res) => {
  const { turnId } = req.params;
  const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
  const answer = typeof req.body?.answer === "string" ? req.body.answer.trim() : "";
  if (!isUuid(turnId)) return res.status(400).json({ success: false, message: "turnId must be a uuid" });
  if (!question || question.length > MAX_QUESTION_CHARS) {
    return res.status(400).json({ success: false, message: `question is required (at most ${MAX_QUESTION_CHARS} characters)` });
  }
  if (!answer || answer.length > MAX_ANSWER_CHARS) {
    return res.status(400).json({ success: false, message: `answer is required (at most ${MAX_ANSWER_CHARS} characters)` });
  }
  try {
    const { faqId, created, gapsRemoved } = await recordAdminAnswer({ question, answer });
    if (!(await markTurnAnswered(turnId, faqId))) logger.warn(`[faq] admin answer saved, but turn ${turnId} was not found`);
    return res.status(200).json({ ok: true, faq_id: faqId, created, gaps_removed: gapsRemoved });
  } catch (error) {
    logger.error("[faq] could not save the admin answer", error);
    return res.status(500).json({ success: false, message: "Could not save the answer" });
  }
};
