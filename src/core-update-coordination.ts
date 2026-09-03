import type { InstallRecord } from "./core-install-record.js";
import {
  type CoreUpdateTransaction,
  completePendingCoreUpdateAfterStart,
  finalizeCoreUpdateTransaction,
  readCoreUpdateTransaction,
  recoverCoreUpdateTransaction,
  rollbackCoreUpdateTransaction,
} from "./core-update.js";
import {
  clearCommittedManagedStateTransaction,
  markRetainedManagedStateTransactionCommitted,
  readManagedStateTransactionStatus,
  recoverManagedStateTransaction,
  rollbackRetainedManagedStateTransaction,
} from "./managed-state-transaction.js";
import type { SashLayout } from "./paths.js";

type CoreExecutableVerifier = (exe: string, expectedVersion: string) => void;

function rollbackRequired(transaction: CoreUpdateTransaction): boolean {
  return (
    transaction.phase === "repair-prepared" ||
    transaction.phase === "repair-restoring" ||
    transaction.phase === "prepared" ||
    (!transaction.deferredHealth && transaction.phase === "swapped")
  );
}

/**
 * Restore both sides of a coordinated update in a fixed order. Managed config,
 * profile and index state are restored before executable/install metadata.
 * Each side is still attempted when the other fails, and failed journals stay.
 */
export function rollbackCoordinatedCoreUpdate(
  layout: SashLayout,
  verifier?: CoreExecutableVerifier,
): InstallRecord | null | undefined {
  const errors: string[] = [];
  let previous: InstallRecord | null | undefined;
  const managed = readManagedStateTransactionStatus(layout);

  if (managed?.coordination === "core-update") {
    if (managed.phase === "committed") {
      errors.push("managed-state commit decision is already durable");
    } else {
      try {
        rollbackRetainedManagedStateTransaction(layout);
      } catch (err) {
        errors.push(`managed state: ${(err as Error).message}`);
      }
    }
  }

  try {
    previous = rollbackCoreUpdateTransaction(layout, verifier);
  } catch (err) {
    errors.push(`Core binary: ${(err as Error).message}`);
  }

  if (errors.length) {
    throw new Error(`Coordinated Core update rollback failed: ${errors.join("; ")}`);
  }
  return previous;
}

/**
 * Recover managed-state and Core update journals as one logical transaction.
 * Pending deferred/health-verified candidates stay published for managed start;
 * interrupted pre-verification candidates roll both sides back.
 */
export function recoverCoordinatedCoreUpdate(
  layout: SashLayout,
  verifier?: CoreExecutableVerifier,
): CoreUpdateTransaction | undefined {
  const managed = readManagedStateTransactionStatus(layout);
  if (managed?.coordination !== "core-update") {
    recoverManagedStateTransaction(layout);
    return recoverCoreUpdateTransaction(layout, verifier);
  }

  const core = readCoreUpdateTransaction(layout);
  if (managed.phase === "committed") {
    if (!core) {
      clearCommittedManagedStateTransaction(layout);
      return undefined;
    }
    if (core.phase === "health-verified") {
      finalizeCoreUpdateTransaction(layout, verifier);
    } else if (core.phase === "swapped" && core.deferredHealth) {
      completePendingCoreUpdateAfterStart(layout, verifier);
    } else {
      throw new Error("Committed managed-state Core update has no durable Core health decision");
    }
    clearCommittedManagedStateTransaction(layout);
    return undefined;
  }

  if (managed.phase === "publishing") {
    if (core) {
      throw new Error(
        "Publishing managed-state Core update unexpectedly overlaps a Core update journal",
      );
    }
    rollbackRetainedManagedStateTransaction(layout);
    return recoverCoreUpdateTransaction(layout, verifier);
  }

  if (!core) {
    rollbackRetainedManagedStateTransaction(layout);
    return recoverCoreUpdateTransaction(layout, verifier);
  }
  if (rollbackRequired(core)) {
    rollbackCoordinatedCoreUpdate(layout, verifier);
    return undefined;
  }
  return recoverCoreUpdateTransaction(layout, verifier);
}

function markManagedCommitDecision(layout: SashLayout): boolean {
  const managed = readManagedStateTransactionStatus(layout);
  if (managed?.coordination !== "core-update") return false;
  if (managed.phase === "retained") {
    markRetainedManagedStateTransactionCommitted(layout);
    return true;
  }
  if (managed.phase !== "committed") {
    throw new Error("Coordinated managed-state publication is not ready to commit");
  }
  return true;
}

function clearManagedCommitDecision(layout: SashLayout, coordinated: boolean): void {
  if (coordinated) clearCommittedManagedStateTransaction(layout);
}

/** Commit a deferred coordinated update after the candidate completed managed start. */
export function completeCoordinatedCoreUpdateAfterStart(
  layout: SashLayout,
  verifier?: CoreExecutableVerifier,
): string | undefined {
  const coordinated = markManagedCommitDecision(layout);
  const version = completePendingCoreUpdateAfterStart(layout, verifier);
  clearManagedCommitDecision(layout, coordinated);
  return version;
}

/** Finalize a health-verified coordinated update after external runtime restoration. */
export function finalizeCoordinatedCoreUpdate(
  layout: SashLayout,
  verifier?: CoreExecutableVerifier,
): void {
  const coordinated = markManagedCommitDecision(layout);
  finalizeCoreUpdateTransaction(layout, verifier);
  clearManagedCommitDecision(layout, coordinated);
}
