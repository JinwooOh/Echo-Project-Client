import path from "path";
import fs from "fs";
import { display, onButtonPressed, onButtonReleased } from "./device/display";
import { recordAudioManually, playAudioData } from "./device/audio";
import { createButtonHandler } from "./device/button";
import { recognizeAudio } from "./asr/openai-asr";
import {
  submitSong,
  waitForJobComplete,
  fetchAudio,
  healthCheck,
} from "./api/echo-api";
import dotenv from "dotenv";

dotenv.config();

export const GENRE_PRESETS = [
  { label: "K-indie", style: "K-indie, hopeful, spring, gentle guitar" },
  { label: "Pop", style: "Pop, upbeat, summer, synth" },
  { label: "Acoustic", style: "Acoustic, calm, coffee shop" },
  { label: "Electronic", style: "Electronic, ambient, dreamy" },
  { label: "Jazz", style: "Jazz, smooth, late night" },
];

export type FlowState =
  | "idle"
  | "recording"
  | "transcribing"
  | "submitting"
  | "generating"
  | "playing";

const recordingsDir = path.join(
  process.env.DATA_DIR || "./data",
  "recordings"
);

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export class EchoFlow {
  private state: FlowState = "idle";
  private genreIndex = 0;
  private currentRecordFilePath = "";
  private stopRecording: (() => void) | null = null;

  constructor() {
    ensureDir(recordingsDir);
    this.setupButtonHandlers();
    this.enterIdle();
  }

  private get currentGenre() {
    return GENRE_PRESETS[this.genreIndex];
  }

  private setupButtonHandlers(): void {
    const handler = createButtonHandler({
      onShortPress: () => this.handleShortPress(),
      onLongPressStart: () => this.handleLongPressStart(),
      onLongPressRelease: () => this.handleLongPressRelease(),
    });
    onButtonPressed(handler.onPress);
    onButtonReleased(handler.onRelease);
  }

  private handleShortPress(): void {
    if (this.state !== "idle") return;
    this.genreIndex = (this.genreIndex + 1) % GENRE_PRESETS.length;
    this.updateIdleDisplay();
  }

  private handleLongPressStart(): void {
    if (this.state !== "idle") return;
    this.enterRecording();
  }

  private handleLongPressRelease(): void {
    if (this.state !== "recording") return;
    this.stopRecording?.();
  }

  private enterIdle(): void {
    this.state = "idle";
    this.updateIdleDisplay();
  }

  private updateIdleDisplay(): void {
    display({
      status: "idle",
      emoji: "🎵",
      text: `${this.currentGenre.label}\n\nHold to sing`,
      RGB: "#00ff30",
    });
  }

  private async enterRecording(): Promise<void> {
    this.state = "recording";
    this.currentRecordFilePath = path.join(
      recordingsDir,
      `user-${Date.now()}.mp3`
    );
    display({
      status: "listening",
      emoji: "😐",
      text: "Listening...",
      RGB: "#00ff00",
    });
    const { result, stop } = recordAudioManually(this.currentRecordFilePath);
    this.stopRecording = stop;
    result
      .then(() => {
        this.stopRecording = null;
        this.enterTranscribing();
      })
      .catch((err) => {
        console.error("Recording error:", err);
        this.stopRecording = null;
        this.enterIdle();
      });
  }

  private async enterTranscribing(): Promise<void> {
    this.state = "transcribing";
    display({
      status: "transcribing",
      emoji: "📝",
      text: "Transcribing...",
      RGB: "#ffaa00",
    });
    const transcript = await recognizeAudio(this.currentRecordFilePath);
    if (!transcript || transcript.trim().length === 0) {
      console.log("Empty transcript, returning to idle");
      display({
        status: "idle",
        emoji: "😕",
        text: "No speech detected\n\nHold to sing",
        RGB: "#ff6600",
      });
      this.enterIdle();
      return;
    }
    await this.enterSubmitting(transcript);
  }

  private async enterSubmitting(transcript: string): Promise<void> {
    this.state = "submitting";
    display({
      status: "sending",
      emoji: "📤",
      text: "Sending...",
      RGB: "#00aaff",
    });
    try {
      const { job_id } = await submitSong(
        transcript.trim(),
        this.currentGenre.style
      );
      await this.enterGenerating(job_id);
    } catch (err) {
      console.error("Submit error:", err);
      display({
        status: "idle",
        emoji: "❌",
        text: "Failed to send\n\nHold to try again",
        RGB: "#ff0000",
      });
      this.enterIdle();
    }
  }

  private async enterGenerating(jobId: string): Promise<void> {
    this.state = "generating";
    display({
      status: "generating",
      emoji: "🎶",
      text: "Generating music...",
      RGB: "#aa00ff",
    });
    try {
      const result = await waitForJobComplete(jobId, (status) => {
        display({
          status: "generating",
          emoji: "🎶",
          text: `Generating... (${status})`,
          RGB: "#aa00ff",
        });
      });
      if (result.status === "error") {
        throw new Error(result.error || "Unknown error");
      }
      if (result.audio_url) {
        await this.enterPlaying(result.audio_url, result.duration_seconds);
      } else {
        throw new Error("No audio URL");
      }
    } catch (err) {
      console.error("Generate error:", err);
      display({
        status: "idle",
        emoji: "❌",
        text: `Error: ${err instanceof Error ? err.message : "Unknown"}\n\nHold to try again`,
        RGB: "#ff0000",
      });
      this.enterIdle();
    }
  }

  private async enterPlaying(
    audioUrl: string,
    durationSeconds?: number | null
  ): Promise<void> {
    this.state = "playing";
    display({
      status: "playing",
      emoji: "🔊",
      text: "Playing...",
      RGB: "#00ff88",
    });
    try {
      const buffer = await fetchAudio(audioUrl);
      const durationMs = durationSeconds
        ? Math.ceil(durationSeconds * 1000)
        : undefined;
      await playAudioData({ buffer, durationMs });
    } catch (err) {
      console.error("Play error:", err);
    }
    this.enterIdle();
  }

  getState(): FlowState {
    return this.state;
  }
}
