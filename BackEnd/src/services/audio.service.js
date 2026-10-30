import { createHmac, randomBytes } from "node:crypto";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

const TTS_MODEL = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
const TTS_VOICE = process.env.OPENAI_TTS_VOICE || "alloy";
const TTS_INSTRUCTIONS =
  "Read this installation guidance clearly at a steady pace, for a technician working on a vehicle. " +
  "Say wire colours, numbers and part names exactly as written.";

/** The longest answer the speech endpoint takes. Refused above this, never cut short: a dropped step is unsafe. */
export const MAX_SPEECH_CHARS = 12000;
const SPEECH_PART_CHARS = 3000;
const MAX_CLIPS = 200;
const MAX_CLIP_CACHE_BYTES = 64 * 1024 * 1024;

let openai;

const getClient = () => {
  if (!openai) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
};

export const transcribeAudio = async (buffer, filename) => {
  const file = await toFile(buffer, filename);

  const transcription = await getClient().audio.transcriptions.create({
    file,
    model: "whisper-1",
    language: "en",
  });

  return transcription.text;
};

/** Long text into parts the speech model accepts, breaking between sentences so no word is split. */
const speechParts = (text) => {
  const parts = [];
  let rest = text;
  while (rest.length > SPEECH_PART_CHARS) {
    const head = rest.slice(0, SPEECH_PART_CHARS);
    const sentenceEnd = Math.max(head.lastIndexOf("\n"), head.lastIndexOf(". "));
    const cut = sentenceEnd > 0 ? sentenceEnd + 1 : head.lastIndexOf(" ") + 1 || SPEECH_PART_CHARS;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) parts.push(rest);
  return parts;
};

// A clip keeps what has been generated, so a replay is free and several listeners can share one generation.
const clips = new Map();
const idSecret = randomBytes(32);

const notify = (clip) => {
  for (const wake of clip.waiting.splice(0)) wake();
};

/** Clips are dropped oldest first once there are too many or they hold too much. One being generated is in use. */
const evictClips = () => {
  let bytes = 0;
  for (const clip of clips.values()) bytes += clip.bytes;
  for (const [id, clip] of clips) {
    if (clips.size <= MAX_CLIPS && bytes <= MAX_CLIP_CACHE_BYTES) return;
    if (clip.started && !clip.done) continue;
    bytes -= clip.bytes;
    clips.delete(id);
  }
};

/**
 * Generates one part at a time, so the first words come back after the first call's first audio, however long
 * the answer is. MP3 frames play straight through when joined, so the parts become one clip. Once a part ends
 * with nobody listening, the rest is not generated: speech is billed.
 */
const generateClip = async (id, clip) => {
  try {
    for (const input of speechParts(clip.text)) {
      if (clip.listeners === 0) {
        clips.delete(id);
        clip.error = new Error("Nobody is listening");
        return;
      }
      const speech = await getClient().audio.speech.create({
        model: TTS_MODEL,
        voice: TTS_VOICE,
        input,
        instructions: TTS_INSTRUCTIONS,
        response_format: "mp3",
      });
      for await (const chunk of speech.body) {
        clip.chunks.push(Buffer.from(chunk));
        clip.bytes += chunk.length;
        notify(clip);
      }
    }
    clip.done = true;
    evictClips();
  } catch (err) {
    clip.error = err;
    clips.delete(id);
  } finally {
    notify(clip);
  }
};

/** Registers the text and returns the id its audio is fetched by. The same text gets the same id. */
export const prepareSpeech = (text) => {
  const id = createHmac("sha256", idSecret).update(text).digest("hex").slice(0, 32);
  if (!clips.has(id)) {
    clips.set(id, { text, chunks: [], bytes: 0, done: false, error: null, started: false, listeners: 0, waiting: [] });
    evictClips();
  }
  return id;
};

/**
 * The clip's MP3 as it is generated, from the first byte, or null for an id that is not known (or has expired).
 * Throws if generation fails: for a listener already part-way through, that must end the response with an error,
 * never look like the answer simply finished.
 */
export const streamSpeech = (id) => {
  const clip = clips.get(id);
  if (!clip) return null;
  clip.listeners += 1;
  if (!clip.started) {
    clip.started = true;
    void generateClip(id, clip);
  }

  return (async function* () {
    try {
      for (let next = 0; ; ) {
        while (next < clip.chunks.length) yield clip.chunks[next++];
        if (clip.error) throw clip.error;
        if (clip.done) return;
        await new Promise((wake) => clip.waiting.push(wake));
      }
    } finally {
      clip.listeners -= 1;
    }
  })();
};
