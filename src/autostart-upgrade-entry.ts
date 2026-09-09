import "./node-version-guard.js";
import { runAutostartUpgrade } from "./daemon/autostart-upgrade.js";
import { installationId } from "./installation.js";
import { currentPackageRoot } from "./package-info.js";
import { takeUpgradeStartupAccess } from "./upgrade-access.js";

const packageRoot = currentPackageRoot();
const access = takeUpgradeStartupAccess(installationId(packageRoot));
if (!access) throw new Error("Login startup maintenance requires private upgrade authority");
await runAutostartUpgrade(process.argv[2] ?? "", access, packageRoot);
