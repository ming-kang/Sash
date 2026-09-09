import "./node-version-guard.js";
import "./daemon/entry.js";
import "./daemon/server.js";
import { packageRuntimeHealth } from "./package-health.js";

process.stdout.write(`${JSON.stringify(packageRuntimeHealth())}\n`);
