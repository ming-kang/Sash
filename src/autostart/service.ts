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
import { windowsAutostart } from "./windows.js";

const INSTALL_HINT = "needs a global installation — run npm install -g @astralyn/sash to enable it";
const AUTOSTART_CACHE_TTL_MS = 30_000;

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
}

interface AutostartServiceOptions extends AutostartOptions {
  backend?: AutostartBackend;
  checkInstallation?: (context: AutostartContext) => string | null;
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
  private inspectionCache: { expiresAt: number; status: AutostartStatus } | undefined;
  private inFlightInspection: Promise<AutostartStatus> | undefined;
  // Bumped by set(): an inspection that started before a mutation must not
  // cache its pre-mutation result once it settles.
  private inspectionGeneration = 0;

  constructor(options: AutostartServiceOptions = {}) {
    this.context = autostartContext(options);
    this.backend =
      options.backend ??
      (this.context.platform === "win32" ? windowsAutostart(this.context) : undefined);
    this.queue = new StateMutationQueue(path.join(this.context.controlDir, "registration.lock"));
    this.checkInstallation = options.checkInstallation ?? installationIssue;
  }

  async inspect(): Promise<AutostartStatus> {
    const backend = this.backend;
    if (!backend) {
      return {
        state: "unsupported",
        canEnable: false,
        reason: `not supported on ${this.context.platform}`,
      };
    }
    if (this.inspectionCache && this.inspectionCache.expiresAt > Date.now()) {
      return this.inspectionCache.status;
    }
    if (this.inFlightInspection) {
      return this.inFlightInspection;
    }
    const generation = this.inspectionGeneration;
    const inspectBackend = async (): Promise<AutostartStatus> => {
      const issue = this.checkInstallation(this.context);
      let status: AutostartStatus;
      try {
        status = {
          state: await backend.inspect(),
          canEnable: issue === null,
          reason: issue,
        };
      } catch (error) {
        status = {
          state: "unknown",
          canEnable: issue === null,
          reason: errorMessage(error),
        };
      }
      if (this.inspectionGeneration === generation) {
        this.inspectionCache = { expiresAt: Date.now() + AUTOSTART_CACHE_TTL_MS, status };
      }
      return status;
    };
    const promise = inspectBackend().finally(() => {
      if (this.inFlightInspection === promise) {
        this.inFlightInspection = undefined;
      }
    });
    this.inFlightInspection = promise;
    return promise;
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
      this.inspectionGeneration += 1;
      this.inspectionCache = undefined;
      this.inFlightInspection = undefined;
      await backend.set(enabled);
      if (!enabled) {
        const issue = this.checkInstallation(this.context);
        const status: AutostartStatus = { state: "off", canEnable: issue === null, reason: issue };
        this.inspectionCache = { expiresAt: Date.now() + AUTOSTART_CACHE_TTL_MS, status };
        return status;
      }
      const status = await this.inspect();
      if (status.state !== "on") {
        throw new Error(`Could not verify autostart: ${status.reason ?? status.state}`);
      }
      return status;
    });
  }
}
