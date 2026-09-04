import type { LogMessage, TrafficMessage } from "../types/index.js";
import { HISTORY_LEN, type StoredLogMessage, store } from "./state.js";
import { isCoreHealthy } from "./state-ownership.js";

const LOG_LEN = 600;
const LOG_FLUSH_MS = 100;
let logSequence = 0;
let pendingLogs: StoredLogMessage[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function addTraffic(message: TrafficMessage, generation = store.runtimeGeneration): void {
  if (generation !== store.runtimeGeneration || !isCoreHealthy(store.status)) return;
  store.traffic = {
    up: message.up,
    down: message.down,
    historyUp: [...store.traffic.historyUp.slice(-(HISTORY_LEN - 1)), message.up],
    historyDown: [...store.traffic.historyDown.slice(-(HISTORY_LEN - 1)), message.down],
  };
}

/**
 * Log frames arrive in bursts; batch them and swap the array once per flush
 * instead of push/shift-ing per frame (each shift used to re-index the whole
 * reactive array and re-render the log view on every single line).
 */
export function addLog(message: LogMessage, generation = store.runtimeGeneration): void {
  if (generation !== store.runtimeGeneration) return;
  pendingLogs.push({ ...message, id: ++logSequence });
  if (flushTimer === null) {
    flushTimer = setTimeout(flushLogs, LOG_FLUSH_MS);
  }
}

export function flushLogs(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingLogs.length === 0) return;
  store.logs = store.logs.concat(pendingLogs).slice(-LOG_LEN);
  pendingLogs = [];
}

export function clearLogs(): void {
  pendingLogs = [];
  store.logs = [];
}
