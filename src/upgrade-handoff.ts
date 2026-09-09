import crypto from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type AutostartStatus, parseAutostartStatus } from "./autostart-contract.js";
import { readBoundedJsonFile } from "./bounded-file.js";
import { type InstallRecord, parseInstallRecord } from "./core-install-record.js";
import { isSha256 } from "./core-integrity.js";
import { parseCoreRuntimeState } from "./core-runtime-state.js";
import { parseCoreYaml } from "./core-yaml.js";
import { parseWebSessionSeeds, type WebSessionSeed } from "./daemon/web-auth.js";
import { errnoCode } from "./error-utils.js";
import { atomicWriteFileSync, durableRemoveFileSync } from "./fs-atomic.js";
import { assertAbsolutePath, canonicalPath, pathsEqual } from "./installation.js";
import { hasExactOwnKeys, isCanonicalIsoTimestamp, isPlainObject } from "./json-shape.js";
import { isValidMihomoConfig, overlayManagedKeys } from "./mihomo-config.js";
import { exactSashVersion, UPGRADE_PROTOCOL } from "./package-info.js";
import type { SashLayout } from "./paths.js";
import type { RuntimeConfiguration, RuntimeRestoreState } from "./runtime-lifecycle.js";
import { validateSettingsCandidate } from "./settings.js";
import { parseUpgradeAccess, type UpgradeAccess } from "./upgrade-access.js";

export type UpgradeHandoffPhase =
  | "reserved"
  | "stopping"
  | "stopped"
  | "restoring"
  | "restored"
  | "committed";
export interface UpgradeHandoff {
  protocol: typeof UPGRADE_PROTOCOL;
  transactionId: string;
  installationId: string;
  dataDir: string;
  sourceBootId: string;
  sourceVersion: string;
  targetVersion: string;
  nodePath: string;
  nodeHistory: string[];
  createdAt: string;
  stateRevision: number;
  stateSha256: string;
  coreInstallation: InstallRecord | null;
  runtime: RuntimeRestoreState;
  autostart: AutostartStatus;
  sessions: WebSessionSeed[];
  continuationExpiresAt: string;
  phase: UpgradeHandoffPhase;
  restoredBootId: string | null;
}

const MAX_HANDOFF_BYTES = 16 * 1024 * 1024;
const PHASES: readonly UpgradeHandoffPhase[] = [
  "reserved",
  "stopping",
  "stopped",
  "restoring",
  "restored",
  "committed",
];

function parseConfiguration(value: unknown): RuntimeConfiguration | null {
  if (value === null) return null;
  if (
    !isPlainObject(value) ||
    !hasExactOwnKeys(value, ["generated", "settings", "profile"]) ||
    !isPlainObject(value.generated)
  )
    throw new Error("Invalid applied configuration handoff");
  const generated = value.generated;
  if (
    !hasExactOwnKeys(generated, ["yaml", "source", "proxyCount"]) ||
    typeof generated.yaml !== "string" ||
    (generated.source !== "default" && generated.source !== "subscription") ||
    typeof generated.proxyCount !== "number" ||
    !Number.isSafeInteger(generated.proxyCount) ||
    generated.proxyCount < 0
  )
    throw new Error("Invalid generated configuration handoff");
  const settings = validateSettingsCandidate(value.settings);
  const doc = parseCoreYaml(generated.yaml);
  if (!isValidMihomoConfig(doc) || !isDeepStrictEqual(doc, overlayManagedKeys(doc, settings)))
    throw new Error("Runtime handoff violates managed configuration constraints");
  const profile = value.profile;
  if (
    profile !== null &&
    (!isPlainObject(profile) ||
      !hasExactOwnKeys(profile, ["id", "revision", "name", "url"]) ||
      typeof profile.id !== "string" ||
      !/^[0-9]+$/.test(profile.id) ||
      typeof profile.revision !== "number" ||
      !Number.isSafeInteger(profile.revision) ||
      profile.revision < 1 ||
      typeof profile.name !== "string" ||
      profile.name.length > 120 ||
      typeof profile.url !== "string")
  )
    throw new Error("Invalid applied profile handoff");
  return {
    generated: { yaml: generated.yaml, source: generated.source, proxyCount: generated.proxyCount },
    settings,
    profile: profile as RuntimeConfiguration["profile"],
  };
}

export function parseUpgradeHandoff(value: unknown): UpgradeHandoff {
  if (
    !isPlainObject(value) ||
    !hasExactOwnKeys(value, [
      "protocol",
      "transactionId",
      "installationId",
      "dataDir",
      "sourceBootId",
      "sourceVersion",
      "targetVersion",
      "nodePath",
      "nodeHistory",
      "createdAt",
      "stateRevision",
      "stateSha256",
      "coreInstallation",
      "runtime",
      "autostart",
      "sessions",
      "continuationExpiresAt",
      "phase",
      "restoredBootId",
    ]) ||
    value.protocol !== UPGRADE_PROTOCOL
  )
    throw new Error("Invalid Sash runtime handoff");
  const access = parseUpgradeAccess({
    transactionId: value.transactionId,
    installationId: value.installationId,
    grant: "0".repeat(64),
  });
  if (
    typeof value.dataDir !== "string" ||
    typeof value.nodePath !== "string" ||
    typeof value.sourceBootId !== "string" ||
    !/^[a-f0-9]{48}$/.test(value.sourceBootId) ||
    !isCanonicalIsoTimestamp(value.createdAt) ||
    !isCanonicalIsoTimestamp(value.continuationExpiresAt) ||
    typeof value.stateRevision !== "number" ||
    !Number.isSafeInteger(value.stateRevision) ||
    value.stateRevision < 0 ||
    !isSha256(value.stateSha256) ||
    !PHASES.some((phase) => phase === value.phase) ||
    (value.restoredBootId !== null &&
      (typeof value.restoredBootId !== "string" || !/^[a-f0-9]{48}$/.test(value.restoredBootId)))
  )
    throw new Error("Invalid Sash handoff identity");
  assertAbsolutePath(value.dataDir);
  assertAbsolutePath(value.nodePath);
  if (
    !Array.isArray(value.nodeHistory) ||
    value.nodeHistory.length < 1 ||
    value.nodeHistory.length > 16 ||
    value.nodeHistory.some((node: unknown) => typeof node !== "string")
  )
    throw new Error("Invalid Node executable handoff history");
  const nodeHistory = value.nodeHistory as string[];
  nodeHistory.forEach(assertAbsolutePath);
  const coreInstallation =
    value.coreInstallation === null ? null : parseInstallRecord(value.coreInstallation);
  if (coreInstallation === undefined || (coreInstallation && !coreInstallation.sha256))
    throw new Error("Core handoff lacks a verified installation");
  const runtime = value.runtime;
  if (
    !isPlainObject(runtime) ||
    !hasExactOwnKeys(runtime, ["configuration", "running", "systemProxyApplied", "core"]) ||
    typeof runtime.running !== "boolean" ||
    typeof runtime.systemProxyApplied !== "boolean"
  )
    throw new Error("Invalid runtime handoff state");
  const configuration = parseConfiguration(runtime.configuration);
  const core = runtime.core === null ? null : parseCoreRuntimeState(runtime.core);
  if (
    runtime.running
      ? !configuration || !core || !coreInstallation
      : core !== null || runtime.systemProxyApplied
  )
    throw new Error("Inconsistent runtime handoff state");
  return {
    protocol: UPGRADE_PROTOCOL,
    transactionId: access.transactionId,
    installationId: access.installationId,
    dataDir: value.dataDir,
    sourceBootId: value.sourceBootId,
    sourceVersion: exactSashVersion(value.sourceVersion),
    targetVersion: exactSashVersion(value.targetVersion),
    nodePath: value.nodePath,
    nodeHistory: [...nodeHistory],
    createdAt: value.createdAt,
    stateRevision: value.stateRevision,
    stateSha256: value.stateSha256,
    coreInstallation,
    runtime: {
      configuration,
      running: runtime.running,
      systemProxyApplied: runtime.systemProxyApplied,
      core,
    },
    autostart: parseAutostartStatus(value.autostart),
    sessions: parseWebSessionSeeds(value.sessions),
    continuationExpiresAt: value.continuationExpiresAt,
    phase: value.phase as UpgradeHandoffPhase,
    restoredBootId: value.restoredBootId,
  };
}

export function upgradeHandoffPath(layout: SashLayout): string {
  return path.join(layout.stateDir, "sash-upgrade-handoff.json");
}

function assertOwner(handoff: UpgradeHandoff, layout: SashLayout, access: UpgradeAccess): void {
  if (
    handoff.transactionId !== access.transactionId ||
    handoff.installationId !== access.installationId ||
    !pathsEqual(handoff.dataDir, canonicalPath(layout.root))
  )
    throw new Error("Sash runtime handoff belongs to a different upgrade or instance");
}

export function writeUpgradeHandoff(
  layout: SashLayout,
  handoff: UpgradeHandoff,
  access: UpgradeAccess,
): void {
  const payload = parseUpgradeHandoff(handoff);
  assertOwner(payload, layout, access);
  const mac = crypto
    .createHmac("sha256", access.grant)
    .update(`sash-upgrade-handoff\0${JSON.stringify(payload)}`)
    .digest("hex");
  const text = `${JSON.stringify({ payload, mac })}\n`;
  if (Buffer.byteLength(text) > MAX_HANDOFF_BYTES)
    throw new Error("Sash runtime handoff exceeds its size limit");
  atomicWriteFileSync(upgradeHandoffPath(layout), text, 0o600);
}

export function readUpgradeHandoff(
  layout: SashLayout,
  access: UpgradeAccess,
): UpgradeHandoff | undefined {
  let value: unknown;
  try {
    value = readBoundedJsonFile(upgradeHandoffPath(layout), MAX_HANDOFF_BYTES);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (!isPlainObject(value) || !hasExactOwnKeys(value, ["payload", "mac"]) || !isSha256(value.mac))
    throw new Error("Invalid signed Sash runtime handoff");
  const expected = crypto
    .createHmac("sha256", access.grant)
    .update(`sash-upgrade-handoff\0${JSON.stringify(value.payload)}`)
    .digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(value.mac, "hex")))
    throw new Error("Sash runtime handoff authentication failed; files preserved");
  const handoff = parseUpgradeHandoff(value.payload);
  assertOwner(handoff, layout, access);
  return handoff;
}

export function clearUpgradeHandoff(layout: SashLayout, access: UpgradeAccess): void {
  if (readUpgradeHandoff(layout, access)) durableRemoveFileSync(upgradeHandoffPath(layout));
}
