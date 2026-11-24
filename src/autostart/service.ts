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
import { createAutostartBackend } from "./index.js";
import { windowsSystemPath } from "./windows-registry.js";

export interface InstallationIssue {
  code: "install" | "wsh";
  message: string;
  detail?: string;
}

const INSTALL_ISSUE: InstallationIssue = {
  code: "install",
  message:
    "Requires a global installation — run npm install -g @astralyn/sash to enable start at login",
  detail: "npm install -g @astralyn/sash",
};
const WSH_ISSUE: InstallationIssue = {
  code: "wsh",
  message:
    "Windows Script Host is missing — restore Windows scripting components to enable start at login",
};

export function installationIssue(ctx: AutostartContext): InstallationIssue | null {
  if (ctx.platform !== "win32") return null;
  try {
    for (const value of [ctx.nodePath, ctx.entryPath, ctx.dataDir]) assertLauncherValue(value);
    assertAbsolutePath(ctx.entryPath);
    if (inspectInstallation(ctx).kind !== "npm-global" || !fs.statSync(ctx.entryPath).isFile())
      return INSTALL_ISSUE;
    for (const host of ["wscript.exe", "cscript.exe"])
      if (!fs.existsSync(windowsSystemPath(ctx, host))) return WSH_ISSUE;
    return null;
  } catch {
    return INSTALL_ISSUE;
  }
}

export interface AutostartController {
  inspect(): Promise<AutostartStatus>;
  set(enabled: boolean): Promise<AutostartStatus>;
  current(): AutostartStatus;
}

export interface AutostartServiceOptions extends AutostartOptions {
  backend?: AutostartBackend;
  checkInstallation?: (context: AutostartContext) => InstallationIssue | null;
  onChange?: () => void;
}

export class AutostartUnavailableError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "AutostartUnavailableError";
  }
}

export class AutostartService implements AutostartController {
  private readonly context: AutostartContext;
  private readonly backend: AutostartBackend | undefined;
  private readonly queue: StateMutationQueue;
  private readonly checkInstallation: (context: AutostartContext) => InstallationIssue | null;
  private readonly onChange: (() => void) | undefined;
  private observed: AutostartStatus | undefined;
  private inspecting: Promise<AutostartStatus> | undefined;
  private latestRead = 0;

  constructor(options: AutostartServiceOptions = {}) {
    this.context = autostartContext(options);
    this.backend = options.backend ?? createAutostartBackend(this.context);
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
        reason: `Start at login is not supported on ${this.context.platform}`,
        reasonCode: "platform",
        reasonDetail: this.context.platform,
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
    let issue: InstallationIssue | null;
    try {
      issue = this.checkInstallation(this.context);
    } catch (error) {
      return this.publish({ state: "unknown", canEnable: false, reason: errorMessage(error) });
    }
    const issueFields = issue
      ? {
          reason: issue.message,
          reasonCode: issue.code,
          ...(issue.detail !== undefined ? { reasonDetail: issue.detail } : {}),
        }
      : { reason: null };
    let status: AutostartStatus;
    try {
      status = {
        state: await backend.inspect(),
        canEnable: issue === null,
        ...issueFields,
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
      } catch {}
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
        if (issue) throw new AutostartUnavailableError(issue.message);
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
      return this.publish({
        state: "off",
        canEnable: issue === null,
        reason: issue?.message ?? null,
        ...(issue
          ? {
              reasonCode: issue.code,
              ...(issue.detail !== undefined ? { reasonDetail: issue.detail } : {}),
            }
          : {}),
      });
    });
  }
}
