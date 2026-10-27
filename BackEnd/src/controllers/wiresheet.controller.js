import { loadWiresheetReport, listWiresheetMakes } from "../db/wiresheet.js";
import { buildTrackerWorkbook } from "../services/wiresheetReport.service.js";
import { logger } from "../utils/logger.js";

/**
 * GET /api/wiresheet/tracker.xlsx[?make=Acura]
 * Streams the Wiresheet data from the DB as the tracker-format Excel workbook
 * the admin panel's download button requests. With ?make it exports one make
 * (smaller/faster); without it, everything scraped so far.
 */
export const downloadTracker = async (req, res) => {
  try {
    const make = typeof req.query.make === "string" && req.query.make.trim() ? req.query.make.trim() : undefined;
    const records = await loadWiresheetReport(make);

    const workbook = await buildTrackerWorkbook(records);
    const stamp = new Date().toISOString().slice(0, 10);
    const slug = make ? `-${make.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : "";
    const filename = `wiresheet-tracker${slug}-${stamp}.xlsx`;

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    logger.error("[wiresheet] tracker download failed", err);
    // Only safe to send JSON if we have not already started streaming the file.
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: "Failed to build the Wiresheet tracker" });
    } else {
      res.end();
    }
  }
};

/** GET /api/wiresheet/makes — distinct makes + vehicle counts, for the admin UI. */
export const listMakes = async (_req, res) => {
  try {
    res.json({ makes: await listWiresheetMakes() });
  } catch (err) {
    logger.error("[wiresheet] listing makes failed", err);
    res.status(500).json({ success: false, message: "Failed to load Wiresheet makes" });
  }
};
