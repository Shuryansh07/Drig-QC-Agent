import express from "express";
import { queryRag } from "../controllers/rag.controller.js";

const router = express.Router();

router.post("/query", queryRag);

export default router;
