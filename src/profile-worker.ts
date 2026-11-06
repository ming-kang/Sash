import { parentPort } from "node:worker_threads";
import YAML from "yaml";
import { countProxies, type GeneratedConfig, renderConfig } from "./mihomo-config.js";
import type { ProfileSummary, ProfileWork, ProfileWorkReply } from "./profile-work.js";
import { parseProfileText } from "./profiles.js";

// Keep only the current source. Validation followed by rendering reuses its
// parsed document without retaining an entire subscription library in memory.
let text: string | undefined;
let document: Record<string, unknown> | undefined;
parentPort?.on("message", (work: ProfileWork) => {
  try {
    let value: ProfileSummary | GeneratedConfig;
    if (work.kind === "mirrors") {
      // This YAML was already generated: keep its metadata/key order, without
      // applying source-input limits or the managed settings overlay again.
      const prepared = YAML.parse(work.generated.yaml) as Record<string, unknown>;
      value = {
        ...work.generated,
        yaml: YAML.stringify({ ...prepared, "geox-url": { ...work.mirrors } }, { indent: 2 }),
      };
    } else {
      if (work.text !== text || !document) {
        document = parseProfileText(work.text);
        text = work.text;
      }
      value =
        work.kind === "render"
          ? renderConfig(document, work.settings, "subscription")
          : { proxyCount: countProxies(document) };
    }
    parentPort?.postMessage({ id: work.id, value } satisfies ProfileWorkReply);
  } catch (error) {
    parentPort?.postMessage({
      id: work.id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies ProfileWorkReply);
  }
});
