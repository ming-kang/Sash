import type { LogMessage, TrafficMessage } from "../types/index.js";
import { HISTORY_LEN, store } from "./state.js";
import { isCoreHealthy } from "./state-ownership.js";

const LOG_LEN = 600;
let logSequence = 0;

export function addTraffic(message: TrafficMessage, generation = store.runtimeGeneration): void {
  if (generation !== store.runtimeGeneration || !isCoreHealthy(store.status)) return;
  store.traffic.up = message.up;
  store.traffic.down = message.down;
  store.traffic.historyUp.push(message.up);
  store.traffic.historyDown.push(message.down);
  if (store.traffic.historyUp.length > HISTORY_LEN) store.traffic.historyUp.shift();
  if (store.traffic.historyDown.length > HISTORY_LEN) store.traffic.historyDown.shift();
}

export function addLog(message: LogMessage, generation = store.runtimeGeneration): void {
  if (generation !== store.runtimeGeneration) return;
  store.logs.push({ ...message, id: ++logSequence });
  if (store.logs.length > LOG_LEN) store.logs.shift();
}

export function clearLogs(): void {
  store.logs = [];
}
