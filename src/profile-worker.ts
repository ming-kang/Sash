import { parentPort } from "node:worker_threads";
import YAML from "yaml";
import {
  countProxies,
  type GeneratedConfig,
  type GeoxMirrorSet,
  renderConfig,
} from "./mihomo-config.js";
import type { ProfileSummary, ProfileWork, ProfileWorkReply } from "./profile-work.js";
import { parseProfileText } from "./profiles.js";

function applyGeoxUrls(generated: GeneratedConfig, mirrors: GeoxMirrorSet): GeneratedConfig {
  const prepared = YAML.parse(generated.yaml) as Record<string, unknown>;
  return {
    ...generated,
    yaml: YAML.stringify({ ...prepared, "geox-url": { ...mirrors } }, { indent: 2 }),
  };
}

let cachedText: string | undefined;
let cachedDocument: Record<string, unknown> | undefined;
parentPort?.on("message", (work: ProfileWork) => {
  try {
    let value: ProfileSummary | GeneratedConfig;
    if (work.kind === "mirrors") {
      value = applyGeoxUrls(work.generated, work.mirrors);
    } else {
      if (work.text !== cachedText || !cachedDocument) {
        cachedDocument = parseProfileText(work.text);
        cachedText = work.text;
      }
      value =
        work.kind === "render"
          ? renderConfig(cachedDocument, work.settings, "subscription")
          : { proxyCount: countProxies(cachedDocument) };
    }
    parentPort?.postMessage({ id: work.id, value } satisfies ProfileWorkReply);
  } catch (error) {
    parentPort?.postMessage({
      id: work.id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies ProfileWorkReply);
  }
});
