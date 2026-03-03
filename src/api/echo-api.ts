import axios, { AxiosInstance } from "axios";
import dotenv from "dotenv";

dotenv.config();

const baseURL = process.env.ECHO_BASE_URL || "http://localhost:8000";
const bearerToken = process.env.ECHO_BEARER_TOKEN || "";
const deviceId = process.env.ECHO_DEVICE_ID || "pi-zero-1";

function createClient(): AxiosInstance {
  return axios.create({
    baseURL,
    headers: {
      "Content-Type": "application/json",
      ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
    },
  });
}

const client = createClient();

export interface SongSubmitResponse {
  job_id: string;
  status_url: string;
}

export interface JobStatusResponse {
  job_id: string;
  status: string;
  lyrics: string | null;
  audio_url: string | null;
  duration_seconds: number | null;
  error: string | null;
}

export async function submitSong(
  transcript: string,
  style: string,
  customDeviceId?: string
): Promise<SongSubmitResponse> {
  const { data } = await client.post<SongSubmitResponse>("/v1/song", {
    device_id: customDeviceId ?? deviceId,
    transcript,
    style,
  });
  return data;
}

export async function getJobStatus(
  jobId: string,
  waitSeconds: number = 60
): Promise<JobStatusResponse> {
  const { data } = await client.get<JobStatusResponse>(
    `/v1/song/${jobId}`,
    { params: { wait: waitSeconds } }
  );
  return data;
}

export async function waitForJobComplete(
  jobId: string,
  onStatus?: (status: string) => void
): Promise<JobStatusResponse> {
  let lastStatus: JobStatusResponse;
  while (true) {
    lastStatus = await getJobStatus(jobId, 60);
    onStatus?.(lastStatus.status);
    if (lastStatus.status === "done" || lastStatus.status === "error") {
      return lastStatus;
    }
  }
}

export async function fetchAudio(audioUrl: string): Promise<Buffer> {
  let fullUrl = audioUrl.startsWith("http")
    ? audioUrl
    : `${baseURL.replace(/\/$/, "")}${audioUrl}`;
  // Backend may return localhost URLs; replace with ECHO_BASE_URL so remote clients reach the backend
  try {
    const u = new URL(fullUrl);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
      const base = new URL(baseURL);
      fullUrl = `${base.origin}${u.pathname}${u.search}`;
    }
  } catch {
    // keep fullUrl as-is if URL parse fails
  }
  const { data } = await axios.get(fullUrl, {
    responseType: "arraybuffer",
    headers: bearerToken
      ? { Authorization: `Bearer ${bearerToken}` }
      : {},
  });
  return Buffer.from(data);
}

export async function healthCheck(): Promise<boolean> {
  try {
    const url = baseURL.replace(/\/$/, "") + "/health";
    const { data } = await axios.get(url);
    return data?.ok === true;
  } catch {
    return false;
  }
}
