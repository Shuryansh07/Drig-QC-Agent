import express from "express";
import { queryRag, streamRagQuery } from "../controllers/rag.controller.js";

const router = express.Router();

router.post("/query", queryRag);
router.post("/query/stream", streamRagQuery);

export default router;
