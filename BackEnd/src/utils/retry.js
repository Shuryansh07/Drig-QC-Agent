import { logger } from "./logger.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableStatus = (status) => status === 408 || status === 429 || (status >= 500 && status < 600);

const isRetryableError = (err) => {
  const status = err?.status ?? err?.response?.status ?? err?.statusCode;
  if (status !== undefined) return isRetryableStatus(status);
  // No HTTP status at all -> a network-level failure, not a rejected request.
  return (
    err?.name === "AbortError" ||
    ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"].includes(err?.code)
  );
};

/**
 * Retries a transient failure (429/408/5xx/timeout/connection reset) with
 * exponential backoff + jitter. Permanent errors (400/401/403/404, bad
 * input, bad auth) are never retried — they fail immediately.
 *
 * Note: OpenAI calls already get this same behavior for free from the
 * `openai` SDK's own built-in maxRetries (see config/openaiClient.js) — this
 * utility is for everything else (WorkDrive, and any other external call
 * that doesn't already retry itself).
 */
export const retryWithBackoff = async (
  label,
  fn,
  { maxRetries = parseInt(process.env.MAX_RETRIES || "3", 10), baseDelayMs = 500 } = {}
) => {
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;

      if (!isRetryableError(err) || attempt > maxRetries) {
        throw err;
      }

      const backoff = baseDelayMs * 2 ** (attempt - 1);
      const delay = Math.round(backoff + Math.random() * 0.3 * backoff);

      logger.warn(`[retry] ${label} failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms: ${err.message}`);
      await sleep(delay);
    }
  }
};
