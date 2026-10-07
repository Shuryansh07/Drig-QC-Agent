import express from "express";
import { getCitation } from "../controllers/citations.controller.js";

const router = express.Router();

router.get("/:ref", getCitation);

export default router;
