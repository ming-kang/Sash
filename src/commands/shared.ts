import fs from "node:fs";
import type { RuntimeContext } from "../offline-mutation.js";
import { sashLayout } from "../paths.js";
import { loadSettings, parseSettingsText } from "../settings.js";

export type {
  OfflineMutationOptions,
  OfflineRuntimeReconciliation,
  RuntimeContext,
} from "../offline-mutation.js";
export { runOfflineMutation } from "../offline-mutation.js";

/** CLI entrypoint context: the user data directory plus its committed settings. */
export function runtimeContext(opts: { existingRootOnly?: boolean } = {}): RuntimeContext {
  const layout = sashLayout();
  if (opts.existingRootOnly) {
    // Administrative commands must not initialize or migrate a foreign root
    // before the management layer verifies its Windows owner and privileges.
    try {
      const canonicalLayout = sashLayout(fs.realpathSync(layout.root));
      if (!fs.statSync(canonicalLayout.root).isDirectory()) {
        throw new Error("SASH_HOME is not a directory");
      }
      const settings = parseSettingsText(
        fs.readFileSync(canonicalLayout.settingsFile, "utf8"),
        canonicalLayout.settingsFile,
      );
      return { layout: canonicalLayout, settings };
    } catch (error) {
      throw new Error(
        'Service management requires an existing initialized user root. Run "sash status" once in an ordinary PowerShell using the same SASH_HOME, then retry as the same user in Administrator PowerShell.',
        { cause: error },
      );
    }
  }
  const settings = loadSettings(layout);
  return { layout, settings };
}
