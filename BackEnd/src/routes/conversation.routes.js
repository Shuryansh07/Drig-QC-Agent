import express from "express";
import { getConversationController, recordResolutionController } from "../controllers/conversation.controller.js";

const router = express.Router();

router.get("/:sessionId", getConversationController);
router.post("/:sessionId/turns/:turnId/resolution", recordResolutionController);

export default router;
