import "./node-version-guard.js";
import { startAtLogin } from "./autostart/start.js";
import { errorMessage } from "./error-utils.js";

try {
  await startAtLogin();
} catch (error) {
  console.error(`[sash] Login startup failed: ${errorMessage(error)}`);
  process.exitCode = 1;
}
