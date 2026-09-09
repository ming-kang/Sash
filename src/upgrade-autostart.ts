import path from "node:path";
import type { UpgradeAccess } from "./upgrade-access.js";
import { runUpgradeCommand } from "./upgrade-command.js";
import type { UpgradeJournal } from "./upgrade-journal.js";

export interface UpgradeAutostartAdapter {
  run(
    action: "capture" | "apply" | "rollback" | "cleanup",
    journal: UpgradeJournal,
    access: UpgradeAccess,
  ): Promise<void>;
}

export const upgradeAutostart: UpgradeAutostartAdapter = {
  run: async (action, journal, access) => {
    await runUpgradeCommand(
      journal.installation.nodePath,
      [path.join(journal.installation.packageRoot, "dist", "autostart-upgrade-entry.js"), action],
      {
        cwd: journal.installation.prefix,
        purpose: `Preserve login startup (${action})`,
        upgradeAccess: access,
      },
    );
  },
};
