import "../node-version-guard.js";
import { errorMessage } from "../error-utils.js";
import { startAtLogin } from "./start.js";

try {
  await startAtLogin();
} catch (error) {
  console.error(`[sash] Login startup failed: ${errorMessage(error)}`);
  process.exitCode = 1;
}
