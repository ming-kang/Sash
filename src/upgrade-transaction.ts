import crypto from "node:crypto";
import { errorMessage } from "./error-utils.js";
import { pathEntryExists } from "./fs-atomic.js";
import { canonicalPath, npmPackageRoot, pathsEqual } from "./installation.js";
import { installationRegistryPaths } from "./installation-registry.js";
import { isPlainObject } from "./json-shape.js";
import type { SashPackageInfo } from "./package-info.js";
import { sashLayout } from "./paths.js";
import { withStateLock } from "./state-lock.js";
import {
  readUpgradeAuthorization,
  type UpgradeAccess,
  writeUpgradeAuthorization,
} from "./upgrade-access.js";
import {
  activateUpgradePackage,
  cleanUpgradeInstallation,
  restorePreviousPackage,
  type UpgradeBoundary,
} from "./upgrade-activation.js";
import { type UpgradeAutostartAdapter, upgradeAutostart } from "./upgrade-autostart.js";
import { runUpgradeCommand } from "./upgrade-command.js";
import { assertTreeFingerprint, fingerprintTree } from "./upgrade-files.js";
import { readUpgradeHandoff, upgradeHandoffPath } from "./upgrade-handoff.js";
import {
  createUpgradeRuntimeAdapter,
  discoverUpgradeInstances,
  type UpgradeRuntimeAdapter,
} from "./upgrade-instances.js";
import {
  publishUpgradeBarrier,
  type UpgradeJournal,
  type UpgradePhase,
  writeUpgradeJournal,
} from "./upgrade-journal.js";
import { activateUpgradeShims, verifyStagedShims } from "./upgrade-launcher.js";
import { type SashNpmTarget, stageSashPackage } from "./upgrade-npm.js";
import { verifyUpgradePackage } from "./upgrade-package.js";
import { upgradeTransactionPaths } from "./upgrade-paths.js";

export interface UpgradeResult {
  outcome: "upgraded" | "recovered" | "failed";
  from: string;
  target: string;
  version: string;
  instances: number;
  recoveryRequired: boolean;
  error?: string;
}
export interface UpgradeExecutionOptions {
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
  onDownload?: (downloaded: number, total?: number) => void;
  onBoundary?: UpgradeBoundary;
  runtime?: UpgradeRuntimeAdapter;
  stagePackage?: typeof stageSashPackage;
  discoverInstances?: typeof discoverUpgradeInstances;
  verifyPackage?: typeof verifyUpgradePackage;
  autostart?: UpgradeAutostartAdapter;
}

/** Durable installation decisions stay separate from daemon-owned runtime snapshots. */
export class SashUpgradeTransaction {
  private readonly runtime: UpgradeRuntimeAdapter;
  private access: UpgradeAccess | undefined;

  constructor(
    private journal: UpgradeJournal,
    private readonly options: UpgradeExecutionOptions = {},
  ) {
    this.runtime = options.runtime ?? createUpgradeRuntimeAdapter();
  }

  private boundary = async (name: string): Promise<void> => {
    await this.options.onBoundary?.(name);
  };

  private async save(phase: UpgradePhase, patch: Partial<UpgradeJournal> = {}): Promise<void> {
    const next = { ...this.journal, ...patch, phase };
    writeUpgradeJournal(next);
    this.journal = next;
    this.options.onStage?.(phase);
    await this.boundary(`journal:${phase}`);
  }

  private result(
    outcome: UpgradeResult["outcome"],
    error?: string,
    recoveryRequired = false,
  ): UpgradeResult {
    const committed = this.journal.phase === "committed" || this.journal.phase === "commit-cleanup";
    return {
      outcome,
      from: this.journal.sourceVersion,
      target: this.journal.targetVersion,
      version: committed ? this.journal.targetVersion : this.journal.sourceVersion,
      instances: this.journal.instances.length,
      recoveryRequired,
      ...(error ? { error } : {}),
    };
  }

  private recoverAccess(): UpgradeAccess | undefined {
    if (this.access) return this.access;
    const auth = readUpgradeAuthorization(this.journal.installation.id);
    if (auth) {
      if (auth.transactionId !== this.journal.transactionId)
        throw new Error("Sash upgrade authority belongs to another transaction");
      this.access = {
        transactionId: auth.transactionId,
        installationId: auth.installationId,
        grant: auth.grant,
      };
    } else if (
      this.journal.instances.some((instance) =>
        pathEntryExists(upgradeHandoffPath(sashLayout(instance.source.dataDir))),
      )
    ) {
      throw new Error("Sash upgrade authorization is missing; private handoffs were preserved");
    }
    return this.access;
  }

  async run(target: SashNpmTarget): Promise<UpgradeResult> {
    try {
      const j = this.journal;
      if (j.phase !== "preparing" || target.version !== j.targetVersion)
        throw new Error("Sash upgrade is not at its preparation boundary");
      this.options.onStage?.("preparing");
      const paths = upgradeTransactionPaths(j.installation.prefix, j.transactionId);
      const proof: unknown = JSON.parse(
        await runUpgradeCommand(j.installation.nodePath, [paths.worker, "--self-test"], {
          cwd: paths.root,
          purpose: "Verify independent Sash recovery worker",
          signal: this.options.signal,
        }),
      );
      if (!isPlainObject(proof) || proof.upgradeProtocol !== 1)
        throw new Error("Sash recovery worker has an incompatible protocol");
      const prepared = await (this.options.stagePackage ?? stageSashPackage)({
        prefix: j.installation.prefix,
        transactionId: j.transactionId,
        nodePath: j.installation.nodePath,
        target,
        signal: this.options.signal,
        onStage: this.options.onStage,
        onProgress: this.options.onDownload,
      });
      const staged = canonicalPath(prepared);
      if (!pathsEqual(staged, npmPackageRoot(paths.stage)))
        throw new Error("Prepared Sash package escaped its fixed staging slot");
      const candidate = fingerprintTree(staged);
      const candidateShims = verifyStagedShims(paths.stage, staged);
      this.options.onStage?.("candidate-check");
      await (this.options.verifyPackage ?? verifyUpgradePackage)(
        staged,
        j.targetVersion,
        j.installation.nodePath,
        paths.validationData,
        this.options.signal,
      );
      await this.save("prepared", { candidate, candidateShims });
    } catch (error) {
      return this.compensate(error);
    }
    return withStateLock(
      installationRegistryPaths(this.journal.installation.id).startupLock,
      { purpose: "coordinate Sash self-upgrade", timeoutMs: 30_000 },
      async () => {
        try {
          await this.replaceAndRestore(target);
          await this.finishDecision();
          return this.result("upgraded");
        } catch (error) {
          return this.compensate(error);
        }
      },
    );
  }

  private async replaceAndRestore(target: SashPackageInfo): Promise<void> {
    this.options.signal?.throwIfAborted();
    const installation = this.journal.installation;
    const instances = await (this.options.discoverInstances ?? discoverUpgradeInstances)(
      installation,
      target,
      this.options.signal,
    );
    await this.save("reserving", { instances });
    this.access = {
      transactionId: this.journal.transactionId,
      installationId: installation.id,
      grant: crypto.randomBytes(32).toString("hex"),
    };
    if (readUpgradeAuthorization(installation.id))
      throw new Error("Sash installation already has an upgrade authority");
    writeUpgradeAuthorization({
      ...this.access,
      protocol: 1,
      sourceVersion: this.journal.sourceVersion,
      targetVersion: this.journal.targetVersion,
      instances: instances.map(({ source }) => ({
        dataDir: source.dataDir,
        sourceBootId: source.bootId,
      })),
    });
    publishUpgradeBarrier(this.journal);
    await this.boundary("startup-barrier-published");
    await (this.options.autostart ?? upgradeAutostart).run("capture", this.journal, this.access);
    await this.boundary("login-startup-captured");
    for (const [index, instance] of instances.entries()) {
      this.options.signal?.throwIfAborted();
      await this.runtime.reserve(instance.source, this.access);
      await this.boundary(`instance-reserved:${index}`);
    }
    await this.save("stopping");
    for (const [index, instance] of instances.entries()) {
      this.options.signal?.throwIfAborted();
      await this.runtime.stop(instance.source, this.access);
      await this.boundary(`instance-stopped:${index}`);
    }
    this.options.signal?.throwIfAborted();
    await this.runtime.assertVacant(installation);
    await this.save("activating");
    await activateUpgradePackage(this.journal, this.boundary);
    this.options.signal?.throwIfAborted();
    const paths = upgradeTransactionPaths(installation.prefix, this.journal.transactionId);
    await (this.options.verifyPackage ?? verifyUpgradePackage)(
      installation.packageRoot,
      this.journal.targetVersion,
      installation.nodePath,
      paths.validationData,
      this.options.signal,
    );
    activateUpgradeShims(this.journal, "candidate");
    await this.boundary("candidate-shims-activated");
    await (this.options.autostart ?? upgradeAutostart).run("apply", this.journal, this.access);
    await this.boundary("login-startup-restored");
    await this.save("restoring");
    for (const [index, instance] of instances.entries()) {
      this.options.signal?.throwIfAborted();
      await this.runtime.restore(instance, this.access, this.journal.targetVersion);
      await this.boundary(`instance-restored:${index}`);
    }
    for (const instance of instances) {
      const current = await this.runtime.current(instance);
      if (!current) throw new Error("A restored Sash instance exited before commit");
      await this.runtime.verify(current, this.access);
    }
    this.options.signal?.throwIfAborted();
    if (!this.journal.candidate) throw new Error("Sash candidate ownership is missing");
    assertTreeFingerprint(installation.packageRoot, this.journal.candidate);
    await this.save("committed");
  }

  private async compensate(error: unknown): Promise<UpgradeResult> {
    const committed = this.journal.phase === "committed" || this.journal.phase === "commit-cleanup";
    try {
      await this.recoverDecision();
      return committed ? this.result("upgraded") : this.result("failed", errorMessage(error));
    } catch (recovery) {
      return this.result(
        "failed",
        `${errorMessage(error)}; recovery is incomplete: ${errorMessage(recovery)}`,
        true,
      );
    }
  }

  async recover(): Promise<UpgradeResult> {
    return withStateLock(
      installationRegistryPaths(this.journal.installation.id).startupLock,
      { purpose: "recover Sash self-upgrade", timeoutMs: 30_000 },
      async () => {
        try {
          await this.recoverDecision();
          return this.result("recovered");
        } catch (error) {
          return this.result("failed", errorMessage(error), true);
        }
      },
    );
  }

  private async recoverDecision(): Promise<void> {
    if (this.journal.phase.endsWith("-cleanup")) {
      await cleanUpgradeInstallation(this.journal, this.boundary);
      return;
    }
    if (["committed", "rolled-back", "cancelled"].includes(this.journal.phase)) {
      await this.finishDecision();
      return;
    }
    if (["preparing", "prepared", "reserving"].includes(this.journal.phase)) {
      await this.save("cancelled");
      await this.finishDecision();
      return;
    }
    await this.save("rolling-back");
    const access = this.recoverAccess();
    if (this.journal.instances.length && !access)
      throw new Error("Sash runtime recovery authority is missing");
    if (access) {
      for (const instance of this.journal.instances) {
        const current = await this.runtime.current(instance);
        if (current) await this.runtime.stop(current, access);
      }
    }
    const active = pathEntryExists(this.journal.installation.packageRoot)
      ? fingerprintTree(this.journal.installation.packageRoot)
      : undefined;
    if (active?.sha256 !== this.journal.source.sha256)
      await this.runtime.assertVacant(this.journal.installation);
    await restorePreviousPackage(this.journal, this.boundary);
    activateUpgradeShims(this.journal, "source");
    if (access)
      await (this.options.autostart ?? upgradeAutostart).run("rollback", this.journal, access);
    if (access) {
      for (const [index, instance] of this.journal.instances.entries()) {
        await this.runtime.restore(instance, access, this.journal.sourceVersion);
        await this.boundary(`rollback-instance-restored:${index}`);
      }
      for (const instance of this.journal.instances) {
        const current = await this.runtime.current(instance);
        if (!current) throw new Error("A rolled-back Sash instance exited before verification");
        await this.runtime.verify(current, access);
      }
    }
    await this.save("rolled-back");
    await this.finishDecision();
  }

  private async finishDecision(): Promise<void> {
    const committed = this.journal.phase === "committed";
    const cancelled = this.journal.phase === "cancelled";
    const version = committed ? this.journal.targetVersion : this.journal.sourceVersion;
    const access = this.recoverAccess();
    if (access) {
      for (const [index, instance] of this.journal.instances.entries()) {
        let current = await this.runtime.current(instance);
        let status = current ? await this.runtime.status(current, access) : undefined;
        if (status?.phase === "none") continue;
        if (
          cancelled &&
          current &&
          status?.phase === "reserved" &&
          current.bootId === instance.source.bootId
        ) {
          await this.runtime.release(current, access);
          await this.boundary(`instance-released:${index}`);
          continue;
        }
        const handoff = readUpgradeHandoff(sashLayout(instance.source.dataDir), access);
        if (!current) {
          if (!handoff) continue;
          if (handoff.phase === "committed") {
            await this.runtime.cleanupStopped(instance, access, version);
            await this.boundary(`stopped-handoff-cleaned:${index}`);
            continue;
          }
          current = await this.runtime.restore(instance, access, version);
          status = await this.runtime.status(current, access);
        }
        if (current.sashVersion !== version)
          throw new Error("Restored Sash instance has an unexpected package version");
        if (status?.phase !== "committed") {
          try {
            await this.runtime.verify(current, access);
          } catch {
            await this.runtime.stop(current, access);
            current = await this.runtime.restore(instance, access, version);
            await this.runtime.verify(current, access);
          }
          await this.runtime.commit(current, access);
          await this.boundary(`instance-committed:${index}`);
        }
        await this.runtime.cleanup(current, access);
        await this.boundary(`instance-handoff-cleaned:${index}`);
      }
    }
    if (access)
      await (this.options.autostart ?? upgradeAutostart).run("cleanup", this.journal, access);
    await this.save(
      committed ? "commit-cleanup" : cancelled ? "cancel-cleanup" : "rollback-cleanup",
    );
    await cleanUpgradeInstallation(this.journal, this.boundary);
  }
}
