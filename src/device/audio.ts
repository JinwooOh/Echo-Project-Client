import { spawn, ChildProcess } from "child_process";
import dotenv from "dotenv";

dotenv.config();

const soundCardIndex = process.env.SOUND_CARD_INDEX || "1";
const alsaOutputDevice = `hw:${soundCardIndex},0`;

const recordFileFormat = "mp3";

let recordingProcessList: ChildProcess[] = [];
let currentRecordingReject: (reason?: unknown) => void = () => {};

const killAllRecordingProcesses = (): void => {
  recordingProcessList.forEach((child) => {
    console.log("Killing recording process", child.pid);
    try {
      child.kill("SIGINT");
    } catch {
      /* ignore */
    }
  });
  recordingProcessList.length = 0;
};

export const recordAudioManually = (
  outputPath: string
): { result: Promise<string>; stop: () => void } => {
  let stopFunc: () => void = () => {};
  const result = new Promise<string>((resolve, reject) => {
    currentRecordingReject = reject;
    const recordingProcess = spawn("sox", [
      "-t",
      "alsa",
      "default",
      "-t",
      recordFileFormat,
      "-c",
      "1",
      "-r",
      "16000",
      outputPath,
    ]);

    recordingProcess.on("error", (err) => {
      killAllRecordingProcesses();
      reject(err);
    });

    recordingProcess.stderr?.on("data", (data) => {
      console.error(data.toString());
    });
    recordingProcessList.push(recordingProcess);
    stopFunc = () => {
      killAllRecordingProcesses();
    };
    recordingProcess.on("exit", () => {
      resolve(outputPath);
    });
  });
  return {
    result,
    stop: stopFunc,
  };
};

const player: { isPlaying: boolean; process: ChildProcess | null } = {
  isPlaying: false,
  process: null,
};

function startPlayerProcess(): ChildProcess {
  return spawn("mpg123", [
    "-",
    "--scale",
    "2",
    "-o",
    "alsa",
    "-a",
    alsaOutputDevice,
  ]);
}

setTimeout(() => {
  const proc = startPlayerProcess();
  proc.on("error", () => {
    console.warn("mpg123 not available - install with: apt install mpg123 (or brew install mpg123)");
  });
  player.process = proc;
}, 5000);

export interface PlayOptions {
  filePath?: string;
  buffer?: Buffer;
  durationMs?: number;
}

export const playAudioData = async (options: PlayOptions): Promise<void> => {
  const { filePath, buffer, durationMs } = options;
  if (filePath) {
    return new Promise((resolve, reject) => {
      const duration = durationMs ? durationMs + 2000 : 300000;
      player.isPlaying = true;
      const proc = spawn("mpg123", [
        filePath,
        "--scale",
        "2",
        "-o",
        "alsa",
        "-a",
        alsaOutputDevice,
      ]);
      proc.on("close", (code) => {
        player.isPlaying = false;
        if (code !== 0 && code !== null) {
          console.error(`Audio playback error: ${code}`);
          reject(new Error(`Playback exited with code ${code}`));
        } else {
          resolve();
        }
      });
      proc.on("error", (err) => {
        player.isPlaying = false;
        reject(err);
      });
      setTimeout(() => {
        if (player.isPlaying) {
          try {
            proc.kill("SIGINT");
          } catch {
            /* ignore */
          }
          resolve();
        }
      }, duration);
    });
  }
  if (buffer && buffer.length > 0) {
    return new Promise((resolve, reject) => {
      const duration = durationMs ? durationMs + 2000 : 300000;
      player.isPlaying = true;
      const proc = spawn("mpg123", [
        "-",
        "--scale",
        "2",
        "-o",
        "alsa",
        "-a",
        alsaOutputDevice,
      ]);
      try {
        proc.stdin?.write(buffer);
        proc.stdin?.end();
      } catch (e) {
        player.isPlaying = false;
        return reject(e);
      }
      proc.on("close", (code) => {
        player.isPlaying = false;
        if (code !== 0 && code !== null) {
          reject(new Error(`Playback exited with code ${code}`));
        } else {
          resolve();
        }
      });
      proc.on("error", (err) => {
        player.isPlaying = false;
        reject(err);
      });
      setTimeout(() => {
        if (player.isPlaying) {
          try {
            proc.kill("SIGINT");
          } catch {
            /* ignore */
          }
          resolve();
        }
      }, duration);
    });
  }
}

export const stopPlaying = (): void => {
  if (player.isPlaying) {
    try {
      const proc = player.process;
      if (proc) {
        proc.stdin?.end();
        proc.kill("SIGINT");
      }
    } catch {
      /* ignore */
    }
    player.isPlaying = false;
    setTimeout(() => {
      player.process = startPlayerProcess();
    }, 500);
  }
};

process.on("SIGINT", () => {
  try {
    if (player.process) {
      player.process.stdin?.end();
      player.process.kill();
    }
  } catch {
    /* ignore */
  }
  process.exit();
});
