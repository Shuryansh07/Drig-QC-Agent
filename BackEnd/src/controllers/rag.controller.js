import { retrieveRelevantChunks } from "../services/ragRetrieval.service.js";
import { generateAnswer } from "../services/answerGeneration.service.js";
import { logger } from "../utils/logger.js";

export const queryRag = async (req, res) => {
  const requestStart = Date.now();
  try {
    const { question } = req.body || {};

    if (!question || typeof question !== "string" || !question.trim()) {
      return res.status(400).json({ success: false, message: "question is required" });
    }

    logger.info(`[rag query] received: "${question}"`);

    const chunks = await retrieveRelevantChunks({ question });
    logger.info(`[rag query] retrieved ${chunks.length} chunk(s)`);

    const { answer, sources } = await generateAnswer({ question, chunks });

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
