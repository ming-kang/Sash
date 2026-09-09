import crypto from "node:crypto";
import path from "node:path";
import { readBoundedFile, readBoundedJsonFile } from "./bounded-file.js";
import { atomicWriteFileSync, pathEntryExists } from "./fs-atomic.js";
import { npmShimPaths, pathsEqual } from "./installation.js";
import { isPlainObject } from "./json-shape.js";
import {
  assertTreeFingerprint,
  readShimImage,
  replaceShim,
  type ShimImage,
  shimImagesEqual,
} from "./upgrade-files.js";
import type { UpgradeJournal } from "./upgrade-journal.js";
import { upgradePaths, upgradeTransactionPaths } from "./upgrade-paths.js";

/** No package imports: this entry remains executable throughout a missing active-package slot. */
export const RECOVERY_LAUNCHER = String.raw`"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
function read(file, limit) {
  if (!fs.lstatSync(file).isFile()) throw new Error("Invalid Sash recovery file");
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error("Sash recovery file exceeds its limit");
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) { const n = fs.readSync(fd, bytes, count, bytes.length - count, null); if (!n) break; count += n; }
    if (count !== stat.size) throw new Error("Sash recovery file changed while reading");
    return bytes.subarray(0, count);
  } finally { fs.closeSync(fd); }
}
try {
  const prefix = fs.realpathSync(path.resolve(__dirname, ".."));
  const info = JSON.parse(read(path.join(__dirname, "launcher.json"), 16384).toString("utf8"));
  if (info.protocol !== 1 || !/^[a-f0-9]{32}$/.test(info.transactionId) || !/^[a-f0-9]{64}$/.test(info.workerSha256) || typeof info.nodePath !== "string" || !path.isAbsolute(info.nodePath)) throw new Error("Invalid Sash recovery launcher metadata");
  const args = process.argv.slice(2);
  let entry;
  let forwarded;
  if (fs.existsSync(path.join(__dirname, "journal.json"))) {
    if (args[0] !== "upgrade") throw new Error("Sash upgrade is in progress; run sash upgrade to recover it");
    if (args.includes("--help")) { process.stdout.write("Usage: sash upgrade [version] [--check] [--json]\nAn interrupted upgrade is recovered before a new upgrade can begin.\n"); process.exit(0); }
    entry = path.join(__dirname, "transactions", info.transactionId, "worker.mjs");
    if (crypto.createHash("sha256").update(read(entry, 16 * 1024 * 1024)).digest("hex") !== info.workerSha256) throw new Error("Sash recovery worker integrity check failed");
    forwarded = [args.includes("--check") ? "--check" : "--recover", prefix, ...args.slice(1)];
  } else {
    entry = path.join(prefix, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules", "@astralyn", "sash", "dist", "cli.js");
    forwarded = args;
  }
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (/^(?:GITHUB_TOKEN|GH_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_PAT|GITHUB_ACCESS_TOKEN|GH_PAT|NPM_TOKEN|NPM_AUTH_TOKEN|NODE_AUTH_TOKEN|NPM_ID_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN|ACTIONS_ID_TOKEN_REQUEST_URL|NODE_OPTIONS|NODE_PATH|SASH_UPGRADE_GRANT|SASH_UPGRADE_TRANSACTION)$/.test(upper) || upper.startsWith("NPM_CONFIG_")) delete env[key];
  }
  const result = spawnSync(info.nodePath, [entry, ...forwarded], { stdio: "inherit", env, cwd: prefix, windowsHide: true, shell: false });
  if (result.error) throw result.error;
  process.exitCode = result.status === null ? 1 : result.status;
} catch (error) { process.stderr.write("Sash recovery: " + error.message + "\n"); process.exitCode = 1; }
`;

export function recoveryShimImages(platform = process.platform): ShimImage[] {
  const relative =
    platform === "win32" ? ".sash-upgrade/launcher.cjs" : "../.sash-upgrade/launcher.cjs";
  const shell = `#!/bin/sh\nbasedir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nif [ -x "$basedir/node" ]; then\n  exec "$basedir/node" "$basedir/${relative}" "$@"\nelse\n  exec node "$basedir/${relative}" "$@"\nfi\n`;
  const cmd =
    '@ECHO off\r\nSETLOCAL\r\nIF EXIST "%~dp0node.exe" (\r\n  "%~dp0node.exe" "%~dp0.sash-upgrade\\launcher.cjs" %*\r\n) ELSE (\r\n  node "%~dp0.sash-upgrade\\launcher.cjs" %*\r\n)\r\n';
  const ps =
    '#!/usr/bin/env pwsh\n$basedir = Split-Path $MyInvocation.MyCommand.Definition -Parent\nif (Test-Path "$basedir/node.exe") {\n  & "$basedir/node.exe" "$basedir/.sash-upgrade/launcher.cjs" @args\n} else {\n  & node "$basedir/.sash-upgrade/launcher.cjs" @args\n}\nexit $LASTEXITCODE\n';
  return (platform === "win32" ? [shell, cmd, ps] : [shell]).map((contents) => ({
    kind: "file",
    sha256: crypto.hash("sha256", contents),
    base64: Buffer.from(contents).toString("base64"),
    mode: platform === "win32" ? 0o666 : 0o755,
  }));
}

export function publishRecoveryLauncher(journal: UpgradeJournal): void {
  const paths = upgradePaths(journal.installation.prefix);
  if (pathEntryExists(paths.launcher)) {
    if (readBoundedFile(paths.launcher, 64 * 1024).toString("utf8") !== RECOVERY_LAUNCHER)
      throw new Error("Sash recovery launcher was changed; files preserved");
    if (pathEntryExists(paths.launcherInfo)) {
      const old = readBoundedJsonFile(paths.launcherInfo, 16 * 1024);
      if (!isPlainObject(old) || old.installationId !== journal.installation.id)
        throw new Error("Recovery launcher belongs to another installation");
    }
  }
  atomicWriteFileSync(paths.launcher, RECOVERY_LAUNCHER, 0o644);
  atomicWriteFileSync(
    paths.launcherInfo,
    `${JSON.stringify({ protocol: 1, transactionId: journal.transactionId, installationId: journal.installation.id, nodePath: journal.installation.nodePath, workerSha256: journal.workerSha256 })}\n`,
    0o644,
  );
}

export function activateUpgradeShims(
  journal: UpgradeJournal,
  role: "recovery" | "source" | "candidate",
): void {
  const next =
    role === "recovery"
      ? journal.recoveryShims
      : role === "source"
        ? journal.sourceShims
        : journal.candidateShims;
  if (!next) throw new Error("Candidate npm shims are missing");
  if (role !== "recovery") {
    const fingerprint = role === "source" ? journal.source : journal.candidate;
    if (!fingerprint) throw new Error("Candidate package ownership is missing");
    assertTreeFingerprint(journal.installation.packageRoot, fingerprint);
  }
  npmShimPaths(journal.installation.prefix).forEach((file, index) => {
    const current = readShimImage(file);
    const target = next[index];
    if (!target) throw new Error("Sash shim role is incomplete");
    if (shimImagesEqual(current, target)) return;
    if (
      ![
        journal.sourceShims[index],
        journal.candidateShims?.[index],
        journal.recoveryShims[index],
      ].some((image) => image && shimImagesEqual(image, current))
    )
      throw new Error(`Sash command entry changed outside the upgrade; preserved ${file}`);
    replaceShim(file, current, target, journal.installation.prefix);
  });
}

export function verifyStagedShims(prefix: string, packageRoot: string): ShimImage[] {
  return npmShimPaths(prefix).map((file) => {
    const image = readShimImage(file);
    if (process.platform === "win32") {
      if (
        image.kind !== "file" ||
        !Buffer.from(image.base64, "base64")
          .toString("utf8")
          .replaceAll("\\", "/")
          .includes("node_modules/@astralyn/sash/dist/cli.js")
      )
        throw new Error("Prepared npm command shim has an unexpected target");
    } else if (
      image.kind !== "link" ||
      !pathsEqual(
        path.resolve(path.dirname(file), image.target),
        path.join(packageRoot, "dist", "cli.js"),
      )
    )
      throw new Error("Prepared npm bin link has an unexpected target");
    return image;
  });
}

export function copyUpgradeWorker(
  journal: Pick<UpgradeJournal, "installation" | "transactionId">,
): string {
  const source = readBoundedFile(
    path.join(journal.installation.packageRoot, "dist", "upgrade-worker.mjs"),
    16 * 1024 * 1024,
  );
  const destination = upgradeTransactionPaths(
    journal.installation.prefix,
    journal.transactionId,
  ).worker;
  atomicWriteFileSync(destination, source, 0o600);
  return crypto.hash("sha256", source);
}
