import { parentPort } from "node:worker_threads";
import { renderConfig } from "./mihomo-config.js";
import type { ProfileWork } from "./profile-work.js";
import { parseProfileText } from "./profiles.js";

// Keep only the current source. Validation followed by rendering reuses its
// parsed document without retaining an entire subscription library in memory.
let text: string | undefined;
let document: Record<string, unknown> | undefined;
parentPort?.on("message", (work: ProfileWork) => {
  try {
    if (work.text !== text || !document) {
      document = parseProfileText(work.text);
      text = work.text;
    }
    const value = work.settings ? renderConfig(document, work.settings, "subscription") : document;
    parentPort?.postMessage({ id: work.id, value });
  } catch (error) {
    parentPort?.postMessage({
      id: work.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
