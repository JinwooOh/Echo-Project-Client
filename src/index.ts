import dotenv from "dotenv";
import { EchoFlow } from "./flow";
import { healthCheck } from "./api/echo-api";

dotenv.config();

async function main() {
  console.log("Echo Pi Client starting...");

  const backendOk = await healthCheck();
  if (!backendOk) {
    console.warn(
      "Backend health check failed. Ensure ECHO_BASE_URL is correct and backend is running."
    );
  } else {
    console.log("Backend OK");
  }

  new EchoFlow();
  console.log("Echo Flow ready. Short press: cycle genre. Long press: record.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
