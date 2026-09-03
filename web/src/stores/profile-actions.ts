import type {
  ProfileActionResponse,
  ProfilesUpdateAllResponse,
  ProfileUpdateResponse,
} from "../../../src/contracts.js";
import { api } from "../api/index.js";
import { refreshRuntimeState } from "./runtime-actions.js";
import { requests, setProfiles, store } from "./state.js";
import { runProfileMutationSequence } from "./state-ownership.js";

export async function refreshProfiles(): Promise<void> {
  const profileRequest = requests.begin("profiles");
  const status = store.status;
  const profiles = await api.getProfiles();
  if (!requests.isCurrent("profiles", profileRequest)) return;
  setProfiles(profiles);
  if (status && store.status?.daemon.startedAt === status.daemon.startedAt) {
    store.lastProfileRevision = status.revisions.profiles;
  }
}

async function performProfileMutation<T>(
  mutation: () => Promise<T>,
  refreshesRuntime: (result: T) => boolean,
): Promise<T> {
  if (store.operations.profileMutation) throw new Error("A profile operation is already running");
  store.operations.profileMutation = true;
  requests.invalidate("runtime");
  requests.invalidate("profiles");
  try {
    return await runProfileMutationSequence(mutation, refreshProfiles, async (result) => {
      if (refreshesRuntime(result)) await refreshRuntimeState();
    });
  } finally {
    store.operations.profileMutation = false;
  }
}

export function addProfile(url: string): Promise<ProfileActionResponse> {
  return performProfileMutation(
    () => api.addProfile(url),
    (result) => result.activated,
  );
}

export function importProfile(name: string, content: string): Promise<ProfileActionResponse> {
  return performProfileMutation(
    () => api.importProfile(name, content),
    (result) => result.activated,
  );
}

export function updateProfile(id: string): Promise<ProfileUpdateResponse> {
  return performProfileMutation(
    () => api.updateProfile(id),
    (result) => result.proxyCount !== undefined,
  );
}

export function writeProfileContent(id: string, content: string): Promise<ProfileUpdateResponse> {
  return performProfileMutation(
    () => api.setProfileContent(id, content),
    (result) => result.proxyCount !== undefined,
  );
}

export function updateAllProfiles(): Promise<ProfilesUpdateAllResponse> {
  return performProfileMutation(
    () => api.updateAllProfiles(),
    (result) => result.proxyCount !== undefined,
  );
}

export function activateProfile(
  id: string | null,
): Promise<{ ok: boolean; activeId: string | null; proxyCount: number }> {
  return performProfileMutation(
    () => api.setActiveProfile(id),
    () => true,
  );
}

export function deleteProfile(
  id: string,
): Promise<{ ok: boolean; wasActive: boolean; proxyCount?: number }> {
  return performProfileMutation(
    () => api.deleteProfile(id),
    (result) => result.wasActive,
  );
}
