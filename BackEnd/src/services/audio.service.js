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

/** MP3 for the text. MP3 frames play straight through when joined, so the parts become one clip. */
export const synthesizeSpeech = async (text) => {
  const clips = await Promise.all(
    speechParts(text).map(async (input) => {
      const speech = await getClient().audio.speech.create({
        model: TTS_MODEL,
        voice: TTS_VOICE,
        input,
        instructions: TTS_INSTRUCTIONS,
        response_format: "mp3",
      });
      return Buffer.from(await speech.arrayBuffer());
    })
  );
  return Buffer.concat(clips);
};
