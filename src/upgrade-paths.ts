import path from "node:path";
import { assertAbsolutePath } from "./installation.js";

export function upgradePaths(prefix: string) {
  assertAbsolutePath(prefix);
  const root = path.join(prefix, ".sash-upgrade");
  return {
    root,
    lock: path.join(root, "upgrade.lock"),
    journal: path.join(root, "journal.json"),
    barrier: path.join(root, "barrier.json"),
    launcher: path.join(root, "launcher.cjs"),
    launcherInfo: path.join(root, "launcher.json"),
    transactions: path.join(root, "transactions"),
  };
}

export function upgradeTransactionPaths(prefix: string, transactionId: string) {
  if (!/^[a-f0-9]{32}$/.test(transactionId))
    throw new Error("Invalid Sash upgrade transaction identity");
  const root = path.join(upgradePaths(prefix).transactions, transactionId);
  return {
    root,
    owner: path.join(root, "owner.json"),
    stage: path.join(root, "stage"),
    cache: path.join(root, "npm-cache"),
    config: path.join(root, "npmrc"),
    globalConfig: path.join(root, "global-npmrc"),
    previous: path.join(root, "previous-package"),
    rejected: path.join(root, "rejected-package"),
    worker: path.join(root, "worker.mjs"),
    archive: path.join(root, "candidate.tgz"),
    validationData: path.join(root, "validation-data"),
  };
}
