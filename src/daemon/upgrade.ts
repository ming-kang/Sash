import crypto from "node:crypto";
import fs from "node:fs";
import { MihomoApi } from "../api.js";
import { StateConflictError } from "../app-state.js";
import { readBoundedFile } from "../bounded-file.js";
import type { UpgradeRuntimeStatus, WebSessionInfo } from "../contracts.js";
import { assertCoreInstallationConsistent } from "../core.js";
import { installRecordsEqual, readInstallRecord } from "../core-install-record.js";
import { assertCoreBinaryDigest } from "../core-integrity.js";
import { readCoreUpdateTransaction } from "../core-update.js";
import { HttpError } from "../daemon-http.js";
import { canonicalPath, pathsEqual } from "../installation.js";
import { UPGRADE_PROTOCOL } from "../package-info.js";
import { authorizeUpgrade, type UpgradeAccess } from "../upgrade-access.js";
import {
  clearUpgradeHandoff,
  readUpgradeHandoff,
  type UpgradeHandoff,
  writeUpgradeHandoff,
} from "../upgrade-handoff.js";
import type { DaemonContext } from "./context.js";
import { WEB_CONTINUATION_TTL_MS } from "./web-auth.js";

/** Only the daemon writes private runtime snapshots; the updater sees lifecycle acknowledgements. */
export class DaemonUpgradeService {
  private current: { access: UpgradeAccess; handoff: UpgradeHandoff } | undefined;

  constructor(private readonly ctx: DaemonContext) {}

  private authorize(access: UpgradeAccess) {
    if (access.installationId !== this.ctx.installationId)
      throw new StateConflictError("Sash upgrade belongs to another installation");
    return authorizeUpgrade(access, this.ctx.layout.root);
  }

  private requireCurrent(access: UpgradeAccess): UpgradeHandoff {
    this.authorize(access);
    const handoff = readUpgradeHandoff(this.ctx.layout, access);
    if (!handoff || !this.current || this.current.access.transactionId !== access.transactionId)
      throw new StateConflictError("This daemon has no matching Sash upgrade reservation");
    return handoff;
  }

  private checkpoint(access: UpgradeAccess, handoff: UpgradeHandoff): void {
    writeUpgradeHandoff(this.ctx.layout, handoff, access);
    this.current = { access, handoff };
  }

  private verifySavedState(handoff: UpgradeHandoff): void {
    const { ctx } = this;
    ctx.state.assertCurrent(handoff.stateRevision);
    if (
      crypto.hash("sha256", readBoundedFile(ctx.layout.settingsFile, 2 * 1024 * 1024)) !==
      handoff.stateSha256
    )
      throw new StateConflictError(
        "Saved Sash state changed during upgrade; recovery files preserved",
      );
    assertCoreInstallationConsistent(ctx.layout);
    if (
      readCoreUpdateTransaction(ctx.layout) ||
      !installRecordsEqual(readInstallRecord(ctx.layout), handoff.coreInstallation)
    )
      throw new StateConflictError("Core installation changed during Sash upgrade");
    if (handoff.coreInstallation)
      assertCoreBinaryDigest(ctx.layout.coreExe, handoff.coreInstallation.sha256);
    else if (fs.existsSync(ctx.layout.coreExe))
      throw new StateConflictError("Unrecognized Core binary appeared during upgrade");
  }

  status(access: UpgradeAccess): UpgradeRuntimeStatus {
    const handoff = this.requireCurrent(access);
    return {
      transactionId: access.transactionId,
      bootId: this.ctx.token,
      version: this.ctx.version,
      phase: handoff.phase,
      running: handoff.runtime.running,
    };
  }

  async reserve(access: UpgradeAccess): Promise<UpgradeRuntimeStatus> {
    const { ctx } = this;
    const authorization = this.authorize(access);
    const owner = authorization.instances.find((item) =>
      pathsEqual(item.dataDir, canonicalPath(ctx.layout.root)),
    );
    if (owner?.sourceBootId !== ctx.token || authorization.sourceVersion !== ctx.version)
      throw new StateConflictError("Sash daemon changed before upgrade reservation");
    await ctx.gate.reserve(access.transactionId);
    try {
      return await ctx.gate.mutateReserved(
        access.transactionId,
        "reserve Sash upgrade",
        async () => {
          if (readUpgradeHandoff(ctx.layout, access)) return this.status(access);
          assertCoreInstallationConsistent(ctx.layout);
          if (readCoreUpdateTransaction(ctx.layout))
            throw new StateConflictError("Finish Core update recovery before upgrading Sash");
          const state = ctx.state.snapshot();
          const ownership = ctx.supervisor.ownedCoreSnapshot();
          const [core, proxy, autostart] = await Promise.all([
            ctx.supervisor.status(),
            ctx.systemProxy.inspect(true),
            ctx.autostart.inspect(),
          ]);
          if (!proxy.appliedKnown || !proxy.stateKnown)
            throw new StateConflictError("Cannot establish system proxy ownership for upgrade");
          if (core.running && (!core.healthy || !ownership || !ctx.supervisor.ownsCore(ownership)))
            throw new StateConflictError("Cannot reserve an unhealthy or unowned Core");
          const configuration = ctx.lifecycle.configuration() ?? null;
          if (
            configuration &&
            readBoundedFile(ctx.layout.configFile, 8 * 1024 * 1024).toString("utf8") !==
              configuration.generated.yaml
          )
            throw new StateConflictError("Applied Core configuration changed outside Sash");
          const runtime = ctx.settings.runtime();
          const coreState = core.running
            ? await new MihomoApi(runtime.controller, runtime.secret).runtimeState()
            : null;
          if (ownership && !ctx.supervisor.ownsCore(ownership))
            throw new StateConflictError("Core changed while capturing upgrade state");
          const handoff: UpgradeHandoff = {
            protocol: UPGRADE_PROTOCOL,
            transactionId: access.transactionId,
            installationId: ctx.installationId,
            dataDir: canonicalPath(ctx.layout.root),
            sourceBootId: ctx.token,
            sourceVersion: ctx.version,
            targetVersion: authorization.targetVersion,
            nodePath: canonicalPath(process.execPath),
            createdAt: new Date().toISOString(),
            stateRevision: state.revision,
            stateSha256: crypto.hash(
              "sha256",
              readBoundedFile(ctx.layout.settingsFile, 2 * 1024 * 1024),
            ),
            coreInstallation: readInstallRecord(ctx.layout) ?? null,
            runtime: {
              configuration,
              running: core.running,
              systemProxyApplied: proxy.applied,
              core: coreState,
            },
            autostart,
            sessions: ctx.webAuth.sessionSeeds(ctx.token),
            continuationExpiresAt: new Date(Date.now() + WEB_CONTINUATION_TTL_MS).toISOString(),
            phase: "reserved",
            restoredBootId: null,
          };
          this.verifySavedState(handoff);
          this.checkpoint(access, handoff);
          return this.status(access);
        },
      );
    } catch (error) {
      // A persisted handoff keeps its reservation until explicit recovery.
      if (!this.current) ctx.gate.releaseReservation(access.transactionId);
      throw error;
    }
  }

  async release(access: UpgradeAccess): Promise<void> {
    await this.ctx.gate.mutateReserved(access.transactionId, "release Sash upgrade", () => {
      const handoff = this.requireCurrent(access);
      if (handoff.phase !== "reserved" || handoff.sourceBootId !== this.ctx.token)
        throw new StateConflictError("Sash runtime must be restored before releasing this upgrade");
      this.verifySavedState(handoff);
      clearUpgradeHandoff(this.ctx.layout, access);
      this.current = undefined;
      this.ctx.gate.releaseReservation(access.transactionId);
    });
  }

  async stop(access: UpgradeAccess): Promise<void> {
    await this.ctx.gate.mutateReserved(access.transactionId, "stop for Sash upgrade", async () => {
      const handoff = this.requireCurrent(access);
      this.verifySavedState(handoff);
      this.checkpoint(access, {
        ...handoff,
        phase: "stopping",
        sessions: this.ctx.webAuth.sessionSeeds(this.ctx.token),
      });
      await this.ctx.lifecycle.stop();
      this.checkpoint(access, { ...this.requireCurrent(access), phase: "stopped" });
    });
    await this.ctx.shutdown();
  }

  /** Invoked before the listener and instance record are published by an authorized new boot. */
  async restoreStartup(access: UpgradeAccess): Promise<void> {
    const authorization = this.authorize(access);
    const handoff = readUpgradeHandoff(this.ctx.layout, access);
    if (
      !handoff ||
      handoff.sourceVersion !== authorization.sourceVersion ||
      handoff.targetVersion !== authorization.targetVersion ||
      ![authorization.sourceVersion, authorization.targetVersion].includes(this.ctx.version)
    )
      throw new StateConflictError("Sash runtime handoff and installed version do not match");
    this.verifySavedState(handoff);
    await this.ctx.gate.reserve(access.transactionId);
    await this.ctx.gate.mutateReserved(
      access.transactionId,
      "restore Sash upgrade runtime",
      async () => {
        this.checkpoint(access, { ...handoff, phase: "restoring", restoredBootId: this.ctx.token });
        await this.ctx.lifecycle.recoverStartup();
        await this.ctx.lifecycle.restore(handoff.runtime);
        this.ctx.webAuth.installContinuation(
          handoff.sessions,
          access.grant,
          this.ctx.token,
          Date.parse(handoff.continuationExpiresAt),
        );
        await this.verifyRuntime(handoff);
        this.checkpoint(access, { ...handoff, phase: "restored", restoredBootId: this.ctx.token });
      },
    );
  }

  private async verifyRuntime(handoff: UpgradeHandoff): Promise<void> {
    this.verifySavedState(handoff);
    const ownership = this.ctx.supervisor.ownedCoreSnapshot();
    const [core, proxy, autostart] = await Promise.all([
      this.ctx.supervisor.status(),
      this.ctx.systemProxy.inspect(true),
      this.ctx.autostart.inspect(),
    ]);
    if (
      core.running !== handoff.runtime.running ||
      (core.running && (!core.healthy || !ownership || !this.ctx.supervisor.ownsCore(ownership)))
    )
      throw new Error("Sash upgrade runtime health verification failed");
    if (
      !proxy.appliedKnown ||
      !proxy.stateKnown ||
      proxy.applied !== handoff.runtime.systemProxyApplied
    )
      throw new Error("Sash upgrade system proxy verification failed");
    if (handoff.autostart.state === "on" && autostart.state !== "on")
      throw new Error("Sash upgrade login startup verification failed");
  }

  async commit(access: UpgradeAccess): Promise<UpgradeRuntimeStatus> {
    const current = this.requireCurrent(access);
    if (current.phase === "committed") return this.status(access);
    return this.ctx.gate.mutateReserved(
      access.transactionId,
      "commit Sash upgrade runtime",
      async () => {
        const handoff = this.requireCurrent(access);
        if (handoff.phase !== "restored")
          throw new StateConflictError("Sash runtime has not been restored");
        await this.verifyRuntime(handoff);
        this.checkpoint(access, { ...handoff, phase: "committed" });
        this.ctx.gate.releaseReservation(access.transactionId);
        return this.status(access);
      },
    );
  }

  async cleanup(access: UpgradeAccess): Promise<void> {
    await this.ctx.mutate("clean Sash upgrade handoff", () => {
      const handoff = this.requireCurrent(access);
      if (handoff.phase !== "committed")
        throw new StateConflictError("Sash upgrade is not committed");
      clearUpgradeHandoff(this.ctx.layout, access);
      this.current = undefined;
    });
  }

  continueWebSession(token: string, sourceBootId: string): Promise<WebSessionInfo> {
    const exchange = (): WebSessionInfo => {
      const session = this.ctx.webAuth.redeemContinuation(token, sourceBootId);
      if (!session)
        throw new HttpError(
          401,
          "Browser upgrade continuation is invalid or expired; run sash web",
        );
      if (this.current && this.current.handoff.phase !== "committed")
        this.checkpoint(this.current.access, {
          ...this.current.handoff,
          sessions: this.ctx.webAuth.sessionSeeds(this.ctx.token),
        });
      return { token: session, daemonToken: this.ctx.token };
    };
    return this.current && this.ctx.gate.isReserved
      ? this.ctx.gate.mutateReserved(
          this.current.access.transactionId,
          "continue browser session",
          exchange,
        )
      : this.ctx.mutate("continue browser session", exchange);
  }
}
