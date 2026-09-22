// MUST be the first import: ES modules evaluate every import's top-level
// code (including src/db/pool.ts, which reads DATABASE_URL eagerly) before
// this file's own body runs — a dotenv.config() call further down would be
// too late. See BackEnd's earlier bug: pool.ts threw "DATABASE_URL is not
// set" even with a populated .env, because it evaluated before dotenv did.
import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import pdfRoutes from "./routes/pdf.routes.js";
import documentRoutes from "./routes/document.routes.js";
import ragRoutes from "./routes/rag.routes.js";
import { getQueueStats } from "./db/jobs.js";
import { logger } from "./utils/logger.js";
import audioRoutes from "./routes/audio.routes.js";

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/pdf", pdfRoutes);
app.use("/api/documents", documentRoutes);
app.use("/api/rag", ragRoutes);
app.use("/api/audio", audioRoutes);

app.get("/", (req, res) => {
  res.json({
    message: "DRIG QC Agent Backend is running",
  });
});

// Job queue is entirely the worker's domain (src/worker.js) now — stale-job
// recovery and temp-file cleanup happen there, not here. The API process
// only reads queue stats for observability.
app.get("/api/health", async (req, res) => {
  try {
    const queue = await getQueueStats();
    res.json({ status: "ok", queue });
  } catch (err) {
    logger.error("Health check failed", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

// multer rejects a non-PDF or an oversized file by passing an error down the
// chain; without this it surfaces as Express's default HTML 500, which the
// admin panel can't show. A rejected upload is the client's mistake: 400 JSON.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err?.code === "UNSUPPORTED_FILE_TYPE") {
    return res.status(400).json({ success: false, message: err.message });
  }
  return next(err);
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
