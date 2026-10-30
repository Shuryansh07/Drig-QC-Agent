import express from "express";
import { getJobContext, queryRag, streamRagQuery } from "../controllers/rag.controller.js";

const router = express.Router();

router.post("/query", queryRag);
router.post("/query/stream", streamRagQuery);
router.get("/job-context", getJobContext);

export default router;
