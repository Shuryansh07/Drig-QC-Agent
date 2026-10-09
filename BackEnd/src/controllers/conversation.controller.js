import { getConversation, setResolution, isUuid } from "../db/chat.js";
import { recordResolution } from "../services/faq.service.js";
import * as storage from "../services/storage.service.js";
import { logger } from "../utils/logger.js";

const RESOLUTIONS = new Set(["resolved", "partly", "not_resolved"]);

/** A saved turn as the browser renders it. Evidence images are re-signed: a stored link would have expired. */
const toWire = async (turn) => {
  const json = turn.turnJson ?? {};
  const images = await Promise.all(
    (json.images ?? []).map(async (img) => {
      try {
        return { label: img.label, document_id: img.docId, page: img.page, url: await storage.getPresignedUrl(img.s3Key) };
      } catch (err) {
        logger.warn(`[chat] could not sign evidence image ${img.s3Key}: ${err.message}`);
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
