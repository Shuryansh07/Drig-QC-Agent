import OpenAI from "openai";

let client;

// Lazy singleton — avoids crashing server startup if OPENAI_API_KEY is
// unset but the RAG routes are never hit.
export const getOpenAIClient = () => {
  if (!client) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error(
        "OPENAI_API_KEY is not set. Add it to BackEnd/.env to use document ingestion or RAG query."
      );
    }
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      // Kept small deliberately: vision.service.js and embedding.service.js
      // now wrap their calls in their own retryWithBackoff (2s/4s/8s/16s/32s,
      // long enough to outlast a sustained per-minute rate limit — see the
      // 43/75-page failure that prompted this). This SDK-level setting only
      // smooths over an instant blip within ONE of those outer attempts;
      // leaving it high here would compound into excessive total wait time
      // (SDK retries × our retries) without adding real reliability.
      maxRetries: parseInt(process.env.OPENAI_MAX_RETRIES || "2", 10),
    });
  }
  return client;
};
