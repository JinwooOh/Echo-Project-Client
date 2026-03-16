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
  { label: "K-pop", style: "K-pop, catchy, energetic, synth, dance" },
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

const MAX_RECORDING_MS = 60_000; // Auto-stop after 60s if button stuck
const MAX_RECORDINGS_KEEP = Math.max(
  1,
  parseInt(process.env.MAX_RECORDINGS_KEEP || "10", 10) || 10
);

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function deleteRecordingFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.warn("Failed to delete recording:", filePath, err);
  }
}

function cleanupOldRecordings(): void {
  try {
    if (!fs.existsSync(recordingsDir)) return;
    const files = fs.readdirSync(recordingsDir)
      .filter((f) => f.endsWith(".mp3"))
      .map((f) => ({
        name: f,
        path: path.join(recordingsDir, f),
        mtime: fs.statSync(path.join(recordingsDir, f)).mtime.getTime(),
      }))
      .sort((a, b) => b.mtime - a.mtime);
    for (let i = MAX_RECORDINGS_KEEP; i < files.length; i++) {
      deleteRecordingFile(files[i].path);
    }
  } catch (err) {
    console.warn("Recordings cleanup failed:", err);
  }
}

export class EchoFlow {
  private state: FlowState = "idle";
  private genreIndex = 0;
  private currentRecordFilePath = "";
  private stopRecording: (() => void) | null = null;

  constructor() {
    ensureDir(recordingsDir);
    cleanupOldRecordings();
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
    const genreList = GENRE_PRESETS.map(
      (g, i) => (i === this.genreIndex ? "▶ " : "  ") + g.label
    ).join("\n");
    display({
      status: "idle",
      emoji: "🎵",
      text: `${genreList}\n\nHold to speak`,
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
    const maxDurationTimer = setTimeout(() => {
      if (this.state === "recording" && this.stopRecording) {
        console.log("[Flow] Max recording duration reached, auto-stopping");
        this.stopRecording();
      }
    }, MAX_RECORDING_MS);
    result
      .then(() => {
        clearTimeout(maxDurationTimer);
        this.stopRecording = null;
        this.enterTranscribing();
      })
      .catch((err) => {
        clearTimeout(maxDurationTimer);
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
    deleteRecordingFile(this.currentRecordFilePath);
    if (!transcript || transcript.trim().length === 0) {
      console.log("Empty transcript, returning to idle");
      display({
        status: "idle",
        emoji: "😕",
        text: "No speech detected\n\nHold to speak",
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
      await this.enterGenerating(job_id, transcript.trim());
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

  private async enterGenerating(jobId: string, transcript: string): Promise<void> {
    this.state = "generating";
    display({
      status: "generating",
      emoji: "🎶",
      text: transcript || "Generating...",
      RGB: "#aa00ff",
    });
    try {
      const result = await waitForJobComplete(jobId, (status) => {
        display({
          status: "generating",
          emoji: "🎶",
          text: transcript ? `${transcript}\n(${status})` : `Generating... (${status})`,
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
      console.log("[Flow] Fetching audio from:", audioUrl);
      const buffer = await fetchAudio(audioUrl);
      if (!buffer || buffer.length < 1000) {
        throw new Error(`Audio too small (${buffer?.length ?? 0} bytes)`);
      }
      console.log("[Flow] Playing", buffer.length, "bytes");
      const durationMs = durationSeconds
        ? Math.ceil(durationSeconds * 1000)
        : undefined;
      await playAudioData({ buffer, durationMs });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Play error:", err);
      display({
        status: "idle",
        emoji: "❌",
        text: `Play failed: ${msg}\n\nHold to try again`,
        RGB: "#ff0000",
      });
    }
    this.enterIdle();
  }

  getState(): FlowState {
    return this.state;
  }
}
