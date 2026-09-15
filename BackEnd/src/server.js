import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pdfRoutes from "./routes/pdf.routes.js";
import audioRoutes from "./routes/audio.routes.js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/pdf", pdfRoutes);
app.use("/api/audio", audioRoutes);

app.get("/", (req, res) => {
  res.json({
    message: "DRIG QC Agent Backend is running",
  });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});