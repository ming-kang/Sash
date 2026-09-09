import crypto from "node:crypto";
import { readBoundedJsonFile } from "./bounded-file.js";
import { errnoCode } from "./error-utils.js";
import { atomicWriteFileSync } from "./fs-atomic.js";
import { assertAbsolutePath, canonicalPath, pathsEqual } from "./installation.js";
import { installationRegistryPaths } from "./installation-registry.js";
import { hasExactOwnKeys, isPlainObject } from "./json-shape.js";
import { exactSashVersion, UPGRADE_PROTOCOL } from "./package-info.js";

export interface UpgradeAccess {
  transactionId: string;
  installationId: string;
  grant: string;
}
export interface UpgradeAuthorization extends UpgradeAccess {
  protocol: typeof UPGRADE_PROTOCOL;
  sourceVersion: string;
  targetVersion: string;
  instances: Array<{ dataDir: string; sourceBootId: string }>;
}

export function parseUpgradeAccess(value: unknown): UpgradeAccess {
  if (
    !isPlainObject(value) ||
    !hasExactOwnKeys(value, ["transactionId", "installationId", "grant"]) ||
    typeof value.transactionId !== "string" ||
    !/^[a-f0-9]{32}$/.test(value.transactionId) ||
    typeof value.installationId !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.installationId) ||
    typeof value.grant !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.grant)
  )
    throw new Error("Invalid Sash upgrade authority");
  return {
    transactionId: value.transactionId,
    installationId: value.installationId,
    grant: value.grant,
  };
}

function parseAuthorization(value: unknown): UpgradeAuthorization {
  if (
    !isPlainObject(value) ||
    !hasExactOwnKeys(value, [
      "transactionId",
      "installationId",
      "grant",
      "protocol",
      "sourceVersion",
      "targetVersion",
      "instances",
    ]) ||
    value.protocol !== UPGRADE_PROTOCOL ||
    !Array.isArray(value.instances) ||
    value.instances.length > 1024
  )
    throw new Error("Invalid Sash upgrade authorization file");
  const access = parseUpgradeAccess({
    transactionId: value.transactionId,
    installationId: value.installationId,
    grant: value.grant,
  });
  const instances = value.instances.map((item: unknown) => {
    if (
      !isPlainObject(item) ||
      !hasExactOwnKeys(item, ["dataDir", "sourceBootId"]) ||
      typeof item.dataDir !== "string" ||
      typeof item.sourceBootId !== "string" ||
      !/^[a-f0-9]{48}$/.test(item.sourceBootId)
    )
      throw new Error("Invalid authorized Sash instance");
    assertAbsolutePath(item.dataDir);
    return { dataDir: item.dataDir, sourceBootId: item.sourceBootId };
  });
  if (
    instances.some((item, i) =>
      instances.slice(0, i).some((prior) => pathsEqual(prior.dataDir, item.dataDir)),
    )
  )
    throw new Error("Duplicate Sash upgrade instance");
  return {
    ...access,
    protocol: UPGRADE_PROTOCOL,
    sourceVersion: exactSashVersion(value.sourceVersion),
    targetVersion: exactSashVersion(value.targetVersion),
    instances,
  };
}

export function readUpgradeAuthorization(id: string): UpgradeAuthorization | undefined {
  try {
    const authorization = parseAuthorization(
      readBoundedJsonFile(installationRegistryPaths(id).upgradeAuthFile, 2 * 1024 * 1024),
    );
    if (authorization.installationId !== id)
      throw new Error("Sash upgrade installation identity differs");
    return authorization;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

/** This file is per-user private storage, never part of the installation journal. */
export function writeUpgradeAuthorization(value: UpgradeAuthorization): void {
  const authorization = parseAuthorization(value);
  const text = `${JSON.stringify(authorization)}\n`;
  if (Buffer.byteLength(text) > 2 * 1024 * 1024)
    throw new Error("Sash upgrade authorization exceeds its size limit");
  atomicWriteFileSync(installationRegistryPaths(value.installationId).upgradeAuthFile, text, 0o600);
}

export function authorizeInstallationUpgrade(access: UpgradeAccess): UpgradeAuthorization {
  const expected = readUpgradeAuthorization(access.installationId);
  if (
    !expected ||
    expected.transactionId !== access.transactionId ||
    !crypto.timingSafeEqual(Buffer.from(expected.grant, "hex"), Buffer.from(access.grant, "hex"))
  )
    throw new Error("Sash upgrade authority does not match this installation");
  return expected;
}

export function authorizeUpgrade(access: UpgradeAccess, dataDir: string): UpgradeAuthorization {
  const expected = authorizeInstallationUpgrade(access);
  const directory = canonicalPath(dataDir);
  if (!expected.instances.some((instance) => pathsEqual(instance.dataDir, directory)))
    throw new Error("Sash upgrade authority does not match this instance");
  return expected;
}

/** Consume secrets before any application or child-process code can inherit them. */
export function takeUpgradeStartupAccess(installationId: string): UpgradeAccess | undefined {
  const transactionId = process.env.SASH_UPGRADE_TRANSACTION;
  const grant = process.env.SASH_UPGRADE_GRANT;
  delete process.env.SASH_UPGRADE_TRANSACTION;
  delete process.env.SASH_UPGRADE_GRANT;
  if (transactionId === undefined && grant === undefined) return undefined;
  return parseUpgradeAccess({ transactionId, installationId, grant });
}
