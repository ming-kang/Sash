import { api } from "../api/index.js";
import { t } from "../i18n/index.js";
import { refreshStatus } from "./runtime-actions.js";
import { setProfiles, store } from "./state.js";

export async function refreshProfiles(): Promise<void> {
  const bootId = store.status?.daemon.bootId;
  const revision = store.status?.revisions.state;
  const profiles = await api.getProfiles();
  if (store.status?.daemon.bootId === bootId) {
    setProfiles(profiles);
    store.lastStateRevision = revision ?? null;
  }
}

async function saveProfile<T>(operation: () => Promise<T>): Promise<T> {
  if (store.operations.profileMutation) throw new Error(t("errors.profileBusy"));
  store.operations = { ...store.operations, profileMutation: true };
  try {
    const result = await operation();
    await refreshStatus().catch(() => undefined);
    return result;
  } catch (error) {
    await refreshStatus().catch(() => undefined);
    throw error;
  } finally {
    store.operations = { ...store.operations, profileMutation: false };
  }
}

export function renameProfile(id: string, name: string) {
  return saveProfile(() => api.renameProfile(id, name));
}
export function addProfile(url: string) {
  return saveProfile(() => api.addProfile(url));
}
export function reorderProfiles(ids: readonly string[]) {
  return saveProfile(() => api.reorderProfiles(ids));
}
export function importProfile(name: string, content: string) {
  return saveProfile(() => api.importProfile(name, content));
}
export function updateProfile(id: string) {
  return saveProfile(() => api.updateProfile(id));
}
export function writeProfileContent(id: string, content: string, revision: number) {
  return saveProfile(() => api.setProfileContent(id, content, revision));
}
export function updateAllProfiles() {
  return saveProfile(() => api.updateAllProfiles());
}
export function activateProfile(id: string | null) {
  return saveProfile(() => api.setActiveProfile(id));
}
export function deleteProfile(id: string) {
  return saveProfile(() => api.deleteProfile(id));
}
