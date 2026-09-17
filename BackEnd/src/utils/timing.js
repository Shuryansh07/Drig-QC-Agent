import { logger } from "./logger.js";

// Wraps an async operation and logs how long it took. Used everywhere we
// call an external service (OpenAI, Supabase Storage, Postgres) so slow
// steps are visible in the server log instead of hidden inside one big
// "request took 54s" number.
export const withTiming = async (label, fn) => {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    logger.timing(label, Date.now() - start);
  }
};
