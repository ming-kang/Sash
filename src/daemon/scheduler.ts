import type { ProfileService } from "../profile-service.js";

export interface DaemonScheduler {
  intervalMs?: number;
  kickoffMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export interface ProfileUpdateScheduler {
  stop(): void;
}

/** Periodic auto-update of due subscription profiles. */
export function startProfileUpdateScheduler(
  profiles: ProfileService,
  scheduler: DaemonScheduler = {},
): ProfileUpdateScheduler {
  const intervalMs = scheduler.intervalMs ?? 15 * 60 * 1000;
  const kickoffMs = scheduler.kickoffMs ?? 10_000;
  const scheduleInterval = scheduler.setInterval ?? setInterval;
  const clearScheduledInterval = scheduler.clearInterval ?? clearInterval;
  const scheduleTimeout = scheduler.setTimeout ?? setTimeout;
  const clearScheduledTimeout = scheduler.clearTimeout ?? clearTimeout;

  const autoUpdateProfiles = async (): Promise<void> => {
    try {
      await profiles.updateDue();
    } catch {
      // Individual profile failures are recorded by ProfileService.
    }
  };

  const intervalTimer = scheduleInterval(() => {
    void autoUpdateProfiles();
  }, intervalMs);
  intervalTimer.unref();
  const kickoffTimer = scheduleTimeout(() => {
    void autoUpdateProfiles();
  }, kickoffMs);
  kickoffTimer.unref();

  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      clearScheduledInterval(intervalTimer);
      clearScheduledTimeout(kickoffTimer);
      stopped = true;
    },
  };
}
