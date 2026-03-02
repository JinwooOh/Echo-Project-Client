import fs from "fs";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const apiKey = process.env.OPENAI_API_KEY;
const openai = apiKey ? new OpenAI({ apiKey }) : null;

export const recognizeAudio = async (audioFilePath: string): Promise<string> => {
  if (!openai) {
    console.error("OpenAI API key is not set (OPENAI_API_KEY).");
    return "";
  }
  if (!fs.existsSync(audioFilePath)) {
    console.error("Audio file does not exist:", audioFilePath);
    return "";
  }

  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioFilePath),
      model: "whisper-1",
    });
    console.log("Transcription result:", transcription.text);
    return transcription.text?.trim() ?? "";
  } catch (error) {
    console.error("Audio recognition failed:", error);
    return "";
  }
};
