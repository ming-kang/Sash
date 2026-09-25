import fs from "node:fs";
import path from "node:path";
import { errorMessage } from "../error-utils.js";
import { assertAbsolutePath, inspectInstallation } from "../sash-installation.js";
import { StateMutationQueue } from "../state-lock.js";
import {
  type AutostartBackend,
  type AutostartContext,
  type AutostartOptions,
  assertLauncherValue,
  autostartContext,
} from "./context.js";
import type { AutostartStatus } from "./contract.js";
import { PENDING_AUTOSTART_STATUS } from "./contract.js";
import { windowsAutostart } from "./windows.js";

const INSTALL_HINT = "needs a global installation — run npm install -g @astralyn/sash to enable it";

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
  /** The last observed status; before the first read it reports that observation is pending. */
  current(): AutostartStatus;
}

export interface AutostartServiceOptions extends AutostartOptions {
  backend?: AutostartBackend;
  checkInstallation?: (context: AutostartContext) => string | null;
  /** Called when an observation or a mutation changes the published status. */
  onChange?: () => void;
}

export class AutostartUnavailableError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "AutostartUnavailableError";
  }
}

/** One registration per OS user, serialized across daemon instances. */
export class AutostartService implements AutostartController {
  private readonly context: AutostartContext;
  private readonly backend: AutostartBackend | undefined;
  private readonly queue: StateMutationQueue;
  private readonly checkInstallation: (context: AutostartContext) => string | null;
  private readonly onChange: (() => void) | undefined;
  private observed: AutostartStatus | undefined;
  private inspecting: Promise<AutostartStatus> | undefined;
  private latestRead = 0;

  constructor(options: AutostartServiceOptions = {}) {
    this.context = autostartContext(options);
    this.backend =
      options.backend ??
      (this.context.platform === "win32" ? windowsAutostart(this.context) : undefined);
    this.queue = new StateMutationQueue(path.join(this.context.controlDir, "registration.lock"));
    this.checkInstallation = options.checkInstallation ?? installationIssue;
    this.onChange = options.onChange;
  }

  current(): AutostartStatus {
    return this.observed ?? PENDING_AUTOSTART_STATUS;
  }

  async inspect(): Promise<AutostartStatus> {
    const backend = this.backend;
    if (!backend) {
      return this.publish({
        state: "unsupported",
        canEnable: false,
        reason: `not supported on ${this.context.platform}`,
      });
    }
    if (this.inspecting) return this.inspecting;
    const read = this.readBackend(backend).finally(() => {
      if (this.inspecting === read) this.inspecting = undefined;
    });
    this.inspecting = read;
    return read;
  }

  private async readBackend(backend: AutostartBackend): Promise<AutostartStatus> {
    const read = ++this.latestRead;
    let issue: string | null;
    try {
      issue = this.checkInstallation(this.context);
    } catch (error) {
      return this.publish({ state: "unknown", canEnable: false, reason: errorMessage(error) });
    }
    let status: AutostartStatus;
    try {
      status = {
        state: await backend.inspect(),
        canEnable: issue === null,
        reason: issue,
      };
    } catch (error) {
      status = { state: "unknown", canEnable: issue === null, reason: errorMessage(error) };
    }
    if (read !== this.latestRead) return status;
    return this.publish(status);
  }

  private publish(status: AutostartStatus): AutostartStatus {
    const previous = this.observed;
    this.observed = status;
    if (!previous || JSON.stringify(previous) !== JSON.stringify(status)) {
      try {
        this.onChange?.();
      } catch {
        /* Observation must never affect a mutation result. */
      }
    }
    return status;
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
      if (enabled) {
        const status = await this.readBackend(backend);
        if (status.state !== "on") {
          throw new Error(`Could not verify autostart: ${status.reason ?? status.state}`);
        }
        return status;
      }
      const issue = this.checkInstallation(this.context);
      return this.publish({ state: "off", canEnable: issue === null, reason: issue });
    });
  }
}
