import OpenAI from "openai";
import { toFile } from "openai/uploads";

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
  });

  return transcription.text;
};
