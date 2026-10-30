import express from "express";
import { answerUnansweredController, getConversationController, listUnansweredController, recordResolutionController } from "../controllers/conversation.controller.js";

const router = express.Router();

// Before "/:sessionId", which would otherwise take "unanswered" as a session id.
router.get("/unanswered", listUnansweredController);
router.post("/unanswered/:turnId/answer", answerUnansweredController);
router.get("/:sessionId", getConversationController);
router.post("/:sessionId/turns/:turnId/resolution", recordResolutionController);

export default router;
