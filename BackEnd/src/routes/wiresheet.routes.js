import express from "express";
import { downloadTracker, listMakes } from "../controllers/wiresheet.controller.js";

const router = express.Router();

router.get("/tracker.xlsx", downloadTracker);
router.get("/makes", listMakes);

export default router;
