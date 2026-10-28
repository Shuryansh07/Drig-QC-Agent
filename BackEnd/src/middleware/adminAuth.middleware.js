import crypto from "node:crypto";
import { logger } from "../utils/logger.js";

// Guards the admin routes that change the knowledge base (uploads, deletes,
// re-classifying a manual, importing the wiring guide). The app has no sign-in
// yet (FrontEnd AuthProvider is a stub), so this is a shared admin token:
//
//   ADMIN_API_TOKEN set   -> the request must send "Authorization: Bearer <token>".
//                            Compared in constant time; never logged.
//   ADMIN_API_TOKEN unset -> allowed, exactly as before this guard existed, with
//                            one warning at startup so it is not left open by accident.
//
// Replace with real role checks (app_role / permission) once sign-in exists.

const TOKEN = process.env.ADMIN_API_TOKEN?.trim() || null;
let warned = false;

const digest = (value) => crypto.createHash("sha256").update(value, "utf8").digest();

export const requireAdmin = (req, res, next) => {
  if (!TOKEN) {
    if (!warned) {
      warned = true;
      logger.warn("[auth] ADMIN_API_TOKEN is not set: admin routes (uploads, deletes, wiring guide import) are open to anyone who can reach the API");
    }
    return next();
  }

  const header = req.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  // Hash both sides so the comparison is constant-time regardless of length.
  if (presented && crypto.timingSafeEqual(digest(presented), digest(TOKEN))) return next();

  logger.warn(`[auth] admin route refused: ${req.method} ${req.originalUrl} from ${req.ip}`);
  return res.status(401).json({ success: false, code: "admin_required", message: "Admin access required." });
};
