/**
 * A real shared semaphore, not per-caller bounding. The point: if the worker
 * processes multiple documents concurrently, their Vision/embedding calls
 * must still share ONE global cap — otherwise "bounded concurrency" per
 * document is meaningless once N documents are each independently allowed
 * their own concurrent batch, multiplying the actual load on OpenAI's
 * per-minute rate limit (exactly what caused the 429s seen earlier).
 */
export const createLimiter = (max) => {
  let active = 0;
  const queue = [];

  const runNext = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn()
      .then(resolve, reject)
      .finally(() => {
        active--;
        runNext();
      });
  };

  const run = (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      runNext();
    });

  run.stats = () => ({ active, queued: queue.length, max });

  return run;
};

export const visionLimiter = createLimiter(parseInt(process.env.VISION_CONCURRENCY || "2", 10));
export const embeddingLimiter = createLimiter(parseInt(process.env.EMBEDDING_CONCURRENCY || "2", 10));
