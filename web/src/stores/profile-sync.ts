import { api } from "../api/index.js";
import { setProfiles, store } from "./state.js";

let syncing: Promise<void> | null = null;

/** Whether the stored profile snapshot lags the adopted daemon status. */
export function profilesSyncNeeded(): boolean {
  const status = store.status;
  return Boolean(
    status && (!store.profilesLoaded || store.lastStateRevision !== status.revisions.state),
  );
}

async function drainProfileSync(): Promise<void> {
  while (profilesSyncNeeded()) {
    const status = store.status;
    if (!status) return;
    const bootId = status.daemon.bootId;
    const revision = status.revisions.state;
    const profiles = await api.getProfiles();
    // A response from before a daemon restart is stale and must be discarded;
    // the loop then re-reads the new boot's revision. Recording the pre-fetch
    // revision means a snapshot that advanced mid-flight still counts as
    // outdated and is fetched again inside this same drain.
    if (store.status?.daemon.bootId !== bootId) continue;
    setProfiles(profiles);
    store.profilesLoaded = true;
    store.lastStateRevision = revision;
  }
}

/**
 * Coalesces profile refreshes: every caller shares one drain that keeps
 * fetching until the adopted snapshot is current, and joiners re-verify
 * freshness afterwards so a revision that moved while the drain finished
 * still triggers a fetch.
 */
export function syncProfiles(): Promise<void> {
  syncing ??= drainProfileSync().finally(() => {
    syncing = null;
  });
  return syncing.then(async () => {
    if (profilesSyncNeeded()) await syncProfiles();
  });
}
