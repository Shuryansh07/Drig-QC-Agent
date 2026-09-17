import fs from "node:fs";
import path from "node:path";

// Persists everything to a file too — not just the terminal — so logs are
// readable regardless of how the server was started (nodemon, nohup,
// Postman-adjacent terminal you're not watching, etc).
const LOG_DIR = path.join(process.cwd(), "logs");
const LOG_FILE = path.join(LOG_DIR, "app.log");

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (err) {
  console.error("Failed to create log directory:", err.message);
}

const write = (level, message) => {
  const line = `${new Date().toISOString()} [${level}] ${message}`;

  if (level === "ERROR") console.error(line);
  else console.log(line);

  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (err) {
    console.error("Failed to write to log file:", err.message);
  }
};

export const logger = {
  info: (message) => write("INFO", message),
  warn: (message) => write("WARN", message),
  error: (message, err) => write("ERROR", err ? `${message} — ${err.message}` : message),
  timing: (label, ms) => write("TIMING", `${label}: ${ms}ms`),
};
