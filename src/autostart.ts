import fs from "node:fs";
import path from "node:path";
import {
  type AutostartBackend,
  type AutostartContext,
  type AutostartOptions,
  assertLauncherValue,
  autostartContext,
} from "./autostart/context.js";
import { windowsAutostart } from "./autostart/windows.js";
import type { AutostartStatus } from "./autostart-contract.js";
import { errorMessage } from "./error-utils.js";
import { assertAbsolutePath, inspectInstallation, pathsEqual } from "./installation.js";
import { StateMutationQueue } from "./state-lock.js";

const INSTALL_HINT =
  "Autostart requires a direct global installation. Install with npm install -g @astralyn/sash.";

/** Verify the package layout and its npm bin shim without invoking npm or changing it. */
export function installationIssue(ctx: AutostartContext): string | null {
  try {
    for (const value of [ctx.nodePath, ctx.entryPath, ctx.dataDir]) assertLauncherValue(value);
    assertAbsolutePath(ctx.entryPath);
    if (inspectInstallation(ctx).kind !== "npm-global" || !fs.statSync(ctx.entryPath).isFile())
      return INSTALL_HINT;
    return null;
  } catch {
    return INSTALL_HINT;
  }
}

export interface AutostartController {
  inspect(): Promise<AutostartStatus>;
  set(enabled: boolean): Promise<AutostartStatus>;
  repairAfterUpgrade?(previousNodePaths: readonly string[]): Promise<AutostartStatus>;
}

interface AutostartServiceOptions extends AutostartOptions {
  backend?: AutostartBackend;
  checkInstallation?: (context: AutostartContext) => string | null;
}

export class AutostartUnavailableError extends Error {}

/** One registration per OS user, serialized across daemon instances. */
export class AutostartService implements AutostartController {
  private readonly context: AutostartContext;
  private readonly backend: AutostartBackend | undefined;
  private readonly queue: StateMutationQueue;
  private readonly checkInstallation: (context: AutostartContext) => string | null;

  constructor(options: AutostartServiceOptions = {}) {
    this.context = autostartContext(options);
    this.backend =
      options.backend ??
      (this.context.platform === "win32" ? windowsAutostart(this.context) : undefined);
    this.queue = new StateMutationQueue(path.join(this.context.controlDir, "registration.lock"));
    this.checkInstallation = options.checkInstallation ?? installationIssue;
  }

  async inspect(): Promise<AutostartStatus> {
    if (!this.backend) {
      return {
        state: "unsupported",
        canEnable: false,
        reason: `Autostart is not supported on ${this.context.platform}`,
      };
    }
    const issue = this.checkInstallation(this.context);
    try {
      return {
        state: await this.backend.inspect(),
        canEnable: issue === null,
        reason: issue,
      };
    } catch (error) {
      return {
        state: "unknown",
        canEnable: issue === null,
        reason: errorMessage(error),
      };
    }
  }

  async set(enabled: boolean): Promise<AutostartStatus> {
    const backend = this.backend;
    if (!backend) {
      throw new AutostartUnavailableError(`Autostart is not supported on ${this.context.platform}`);
    }
    return this.queue.run("configure autostart", async () => {
      if (enabled) {
        const issue = this.checkInstallation(this.context);
        if (issue) throw new AutostartUnavailableError(issue);
      }
      await backend.set(enabled);
      if (!enabled) {
        const issue = this.checkInstallation(this.context);
        return { state: "off", canEnable: issue === null, reason: issue };
      }
      const status = await this.inspect();
      if (status.state !== "on") {
        throw new Error(`Could not verify autostart: ${status.reason ?? status.state}`);
      }
      return status;
    });
  }

  /** Repair a changed Node path only while the original registration is still ours. */
  async repairAfterUpgrade(previousNodePaths: readonly string[]): Promise<AutostartStatus> {
    if (this.context.platform !== "win32" || !this.backend)
      throw new AutostartUnavailableError("Cannot restore login startup on this platform");
    return this.queue.run("restore login startup after upgrade", async () => {
      const current = await this.inspect();
      if (current.state === "on") return current;
      let owned = false;
      for (const nodePath of previousNodePaths) {
        if (pathsEqual(nodePath, this.context.nodePath)) continue;
        if ((await windowsAutostart({ ...this.context, nodePath }).inspect()) === "on") {
          owned = true;
          break;
        }
      }
      if (!owned)
        throw new Error("Login startup changed outside Sash; its registration was preserved");
      const issue = this.checkInstallation(this.context);
      if (issue) throw new AutostartUnavailableError(issue);
      await this.backend?.set(true);
      const status = await this.inspect();
      if (status.state !== "on") throw new Error("Cannot verify repaired login startup");
      return status;
    });
  }
}
