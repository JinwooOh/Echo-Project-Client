import { exec } from "child_process";
import { resolve } from "path";
import { existsSync } from "fs";
import { Socket } from "net";
import dotenv from "dotenv";
import { WebDisplayServer } from "./web-display";

dotenv.config();

export interface Status {
  status: string;
  emoji: string;
  text: string;
  scroll_speed: number;
  brightness: number;
  RGB: string;
  battery_color: string;
  battery_level: number | undefined;
  image: string;
  camera_mode: boolean;
  capture_image_path: string;
  network_connected: boolean;
  rag_icon_visible: boolean;
  image_icon_visible: boolean;
}

export class EchoDisplay {
  private currentStatus: Status = {
    status: "starting",
    emoji: "🎵",
    text: "Hold to sing",
    scroll_speed: 3,
    brightness: 100,
    RGB: "#00FF30",
    battery_color: "#000000",
    battery_level: undefined,
    image: "",
    camera_mode: false,
    capture_image_path: "",
    network_connected: false,
    rag_icon_visible: false,
    image_icon_visible: false,
  };

  private client: Socket | null = null;
  private buttonPressedCallback: () => void = () => {};
  private buttonReleasedCallback: () => void = () => {};
  private isReady: Promise<void>;
  private pythonProcess: ReturnType<typeof exec> | null = null;
  private webDisplay: WebDisplayServer | null = null;
  private deviceEnabled: boolean;
  private receiveBuffer = "";

  constructor() {
    this.deviceEnabled = parseBoolEnv("WHISPLAY_DEVICE_ENABLED", true);
    const webEnabled = parseBoolEnv("WHISPLAY_WEB_ENABLED", false);
    if (webEnabled) {
      const port = parseInt(process.env.WHISPLAY_WEB_PORT || "17880", 10);
      const host = process.env.WHISPLAY_WEB_HOST || "0.0.0.0";
      this.webDisplay = new WebDisplayServer({
        host,
        port,
        onButtonPress: () => this.handleButtonPressedEvent(),
        onButtonRelease: () => this.handleButtonReleasedEvent(),
      });
      this.webDisplay.updateStatus(this.currentStatus);
    }

    if (this.deviceEnabled) {
      this.startPythonProcess();
      this.isReady = new Promise<void>((resolve) => {
        this.connectWithRetry(15, resolve);
      });
    } else {
      this.isReady = Promise.resolve();
    }
  }

  startPythonProcess(): void {
    if (!this.deviceEnabled) return;
    const pythonDir = resolve(__dirname, "../../python");
    const venvPython = resolve(pythonDir, ".venv/bin/python");
    const pythonCmd = existsSync(venvPython) ? venvPython : "python3";
    const command = `cd ${pythonDir} && ${pythonCmd} echo-ui.py`;
    console.log("Starting Python display process...");
    this.pythonProcess = exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error("Error starting Python process:", error);
        return;
      }
      if (stdout) console.log(stdout.toString());
      if (stderr) console.error(stderr.toString());
    });
    this.pythonProcess.stdout?.on("data", (d) => console.log(d.toString()));
    this.pythonProcess.stderr?.on("data", (d) => console.error(d.toString()));
  }

  killPythonProcess(): void {
    if (this.pythonProcess) {
      console.log("Killing Python process...", this.pythonProcess.pid);
      this.pythonProcess.kill();
      this.pythonProcess = null;
    }
  }

  async connectWithRetry(
    retries: number,
    outerResolve: () => void
  ): Promise<void> {
    if (!this.deviceEnabled) {
      outerResolve();
      return;
    }
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await this.connect();
        outerResolve();
        return;
      } catch (err) {
        console.log(`Connection attempt ${attempt} failed, retrying in 5s...`);
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 5000));
        } else {
          console.error("Failed to connect after retries:", err);
          outerResolve();
        }
      }
    }
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.client) {
        this.client.destroy();
      }
      this.client = new Socket();
      this.client.connect(12345, "127.0.0.1", () => {
        console.log("Connected to display socket");
        this.receiveBuffer = "";
        this.sendToDisplay(JSON.stringify(this.currentStatus));
        resolve();
      });
      this.client.on("data", (data: Buffer) => {
        this.receiveBuffer += data.toString();
        while (this.receiveBuffer.includes("\n")) {
          const idx = this.receiveBuffer.indexOf("\n");
          const line = this.receiveBuffer.slice(0, idx).trim();
          this.receiveBuffer = this.receiveBuffer.slice(idx + 1);
          if (!line || line === "OK") continue;
          try {
            const json = JSON.parse(line);
            if (json.event === "button_pressed") this.handleButtonPressedEvent();
            if (json.event === "button_released")
              this.handleButtonReleasedEvent();
          } catch {
            /* ignore */
          }
        }
      });
      this.client.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ECONNREFUSED") reject(err);
      });
    });
  }

  onButtonPressed(callback: () => void): void {
    this.buttonPressedCallback = callback;
  }

  onButtonReleased(callback: () => void): void {
    this.buttonReleasedCallback = callback;
  }

  private async sendToDisplay(data: string): Promise<void> {
    if (!this.deviceEnabled) return;
    await this.isReady;
    try {
      this.client?.write(`${data}\n`, "utf8");
    } catch {
      console.error("Failed to update display");
    }
  }

  getCurrentStatus(): Status {
    return { ...this.currentStatus };
  }

  async display(newStatus: Partial<Status> = {}): Promise<void> {
    Object.assign(this.currentStatus, newStatus);
    const data = JSON.stringify(newStatus);
    this.sendToDisplay(data);
    this.webDisplay?.updateStatus(this.currentStatus);
  }

  private handleButtonPressedEvent(): void {
    this.buttonPressedCallback();
  }

  private handleButtonReleasedEvent(): void {
    this.buttonReleasedCallback();
  }

  stopWebDisplay(): void {
    this.webDisplay?.close();
    this.webDisplay = null;
  }
}

const displayInstance = new EchoDisplay();

export const display = displayInstance.display.bind(displayInstance);
export const getCurrentStatus =
  displayInstance.getCurrentStatus.bind(displayInstance);
export const onButtonPressed =
  displayInstance.onButtonPressed.bind(displayInstance);
export const onButtonReleased =
  displayInstance.onButtonReleased.bind(displayInstance);

function parseBoolEnv(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  return raw.toLowerCase() === "true" || raw === "1";
}

function cleanup() {
  displayInstance.killPythonProcess();
  displayInstance.stopWebDisplay();
}

process.on("exit", cleanup);
["SIGINT", "SIGTERM"].forEach((signal) => {
  process.on(signal, () => {
    cleanup();
    process.exit(0);
  });
});
