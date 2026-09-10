import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type AutostartStatus, parseAutostartStatus } from "./autostart-contract.js";
import { type InstallRecord, parseInstallRecord } from "./core-install-record.js";
import { parseCoreRuntimeState } from "./core-runtime-state.js";
import { parseCoreYaml } from "./core-yaml.js";
import { parseWebSessionSeeds, type WebSessionSeed } from "./daemon/web-auth.js";
import { durableRemoveFileSync } from "./fs-atomic.js";
import { assertAbsolutePath, canonicalPath, pathsEqual } from "./installation.js";
import { hasExactOwnKeys, isCanonicalIsoTimestamp, isPlainObject, isSha256 } from "./json-shape.js";
import { isValidMihomoConfig, overlayManagedKeys } from "./mihomo-config.js";
import { exactSashVersion, UPGRADE_PROTOCOL } from "./package-info.js";
import type { SashLayout } from "./paths.js";
import type { RuntimeConfiguration, RuntimeRestoreState } from "./runtime-lifecycle.js";
import { validateSettingsCandidate } from "./settings.js";
import { readSignedFile, writeSignedFile } from "./signed-file.js";
import { parseUpgradeAccess, type UpgradeAccess } from "./upgrade-access.js";

export type UpgradeHandoffPhase =
  | "reserved"
  | "stopping"
  | "stopped"
  | "restoring"
  | "restored"
  | "committed";
export interface UpgradeHandoffLegacyTail {
  nodePath: string;
  stateSha256: string;
  restoredBootId: string | null;
}
export interface UpgradeHandoff {
  protocol: typeof UPGRADE_PROTOCOL;
  transactionId: string;
  installationId: string;
  dataDir: string;
  sourceBootId: string;
  sourceVersion: string;
  targetVersion: string;
  nodeHistory: string[];
  createdAt: string;
  stateRevision: number;
  coreInstallation: InstallRecord | null;
  runtime: RuntimeRestoreState;
  autostart: AutostartStatus;
  sessions: WebSessionSeed[];
  continuationExpiresAt: string;
  phase: UpgradeHandoffPhase;
  /** Present only for handoffs written by 0.1.3/0.1.4; written back verbatim below. */
  legacy?: UpgradeHandoffLegacyTail;
}

const MAX_HANDOFF_BYTES = 16 * 1024 * 1024;
const HANDOFF_ENVELOPE = {
  domain: "sash-upgrade-handoff\0",
  maxBytes: MAX_HANDOFF_BYTES,
  subject: "Sash runtime handoff",
  mode: 0o600,
} as const;
const PHASES: readonly UpgradeHandoffPhase[] = [
  "reserved",
  "stopping",
  "stopped",
  "restoring",
  "restored",
  "committed",
];
const HANDOFF_KEYS = [
  "protocol",
  "transactionId",
  "installationId",
  "dataDir",
  "sourceBootId",
  "sourceVersion",
  "targetVersion",
  "nodeHistory",
  "createdAt",
  "stateRevision",
  "coreInstallation",
  "runtime",
  "autostart",
  "sessions",
  "continuationExpiresAt",
  "phase",
] as const;
// 0.1.3 and 0.1.4 additionally wrote these fields, and their updater keeps
// reading the handoff with an exact-key check while the transaction runs, so an
// upgrade that starts with this shape must keep it until the handoff is cleared.
const LEGACY_HANDOFF_KEYS = [
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
] as const;

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

function parseUpgradeHandoff(value: unknown): UpgradeHandoff {
  if (
    !isPlainObject(value) ||
    (!hasExactOwnKeys(value, HANDOFF_KEYS) && !hasExactOwnKeys(value, LEGACY_HANDOFF_KEYS)) ||
    value.protocol !== UPGRADE_PROTOCOL
  )
    throw new Error("Invalid Sash runtime handoff");
  const legacy = !hasExactOwnKeys(value, HANDOFF_KEYS);
  const access = parseUpgradeAccess({
    transactionId: value.transactionId,
    installationId: value.installationId,
    grant: "0".repeat(64),
  });
  if (
    typeof value.dataDir !== "string" ||
    typeof value.sourceBootId !== "string" ||
    !/^[a-f0-9]{48}$/.test(value.sourceBootId) ||
    !isCanonicalIsoTimestamp(value.createdAt) ||
    !isCanonicalIsoTimestamp(value.continuationExpiresAt) ||
    typeof value.stateRevision !== "number" ||
    !Number.isSafeInteger(value.stateRevision) ||
    value.stateRevision < 0 ||
    !PHASES.some((phase) => phase === value.phase)
  )
    throw new Error("Invalid Sash handoff identity");
  let legacyTail: UpgradeHandoffLegacyTail | undefined;
  if (legacy) {
    const { nodePath, stateSha256, restoredBootId } = value;
    if (
      typeof nodePath !== "string" ||
      !isSha256(stateSha256) ||
      (restoredBootId !== null &&
        (typeof restoredBootId !== "string" || !/^[a-f0-9]{48}$/.test(restoredBootId)))
    )
      throw new Error("Invalid Sash handoff identity");
    assertAbsolutePath(nodePath);
    legacyTail = { nodePath, stateSha256, restoredBootId };
  }
  assertAbsolutePath(value.dataDir);
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
  if (coreInstallation === undefined)
    throw new Error("Core handoff lacks a valid installation record");
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
    nodeHistory: [...nodeHistory],
    createdAt: value.createdAt,
    stateRevision: value.stateRevision,
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
    ...(legacyTail ? { legacy: legacyTail } : {}),
  };
}

function serializeHandoff(handoff: UpgradeHandoff): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...handoff };
  delete fields.legacy;
  if (handoff.legacy) {
    fields.nodePath = handoff.legacy.nodePath;
    fields.stateSha256 = handoff.legacy.stateSha256;
    fields.restoredBootId = handoff.legacy.restoredBootId;
  }
  return fields;
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
  const payload = parseUpgradeHandoff(serializeHandoff(handoff));
  assertOwner(payload, layout, access);
  writeSignedFile(
    upgradeHandoffPath(layout),
    access.grant,
    serializeHandoff(payload),
    HANDOFF_ENVELOPE,
  );
}

export function readUpgradeHandoff(
  layout: SashLayout,
  access: UpgradeAccess,
): UpgradeHandoff | undefined {
  const payload = readSignedFile(upgradeHandoffPath(layout), access.grant, HANDOFF_ENVELOPE);
  if (payload === undefined) return undefined;
  const handoff = parseUpgradeHandoff(payload);
  assertOwner(handoff, layout, access);
  return handoff;
}

export function clearUpgradeHandoff(layout: SashLayout, access: UpgradeAccess): void {
  if (readUpgradeHandoff(layout, access)) durableRemoveFileSync(upgradeHandoffPath(layout));
}
