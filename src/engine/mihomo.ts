import {
  CONFIG_TEST_GEODATA_TIMEOUT_MS,
  geodataFileForFailure,
  isGeodataDownloadFailure,
  validateCoreConfig,
} from "../core-config-validation.js";
import { MihomoApi } from "../mihomo-api.js";
import { GEOX_MIRROR_SETS } from "../mihomo-config.js";
import { renderActiveConfig } from "../profile-service.js";
import type { CoreEngine } from "./index.js";

export const mihomoEngine: CoreEngine = {
  id: "mihomo",
  spawnArguments: (layout) => ["-d", layout.root, "-f", layout.configFile],
  renderActiveConfig: (state, layout) => renderActiveConfig(state, layout),
  validateConfig: (executable, yaml, layout, options) =>
    validateCoreConfig(executable, yaml, layout, options),
  api: (controller, secret) => new MihomoApi(controller, secret),
  geodata: {
    mirrorSets: GEOX_MIRROR_SETS,
    isDownloadFailure: isGeodataDownloadFailure,
    fileForFailure: geodataFileForFailure,
    testTimeoutMs: CONFIG_TEST_GEODATA_TIMEOUT_MS,
  },
};
