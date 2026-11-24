import type { HelperClient, HelperRequest, HelperStatus } from "./protocol.js";

export function mockHelper(coreSha256: string | null, pid = 12345) {
  let state: HelperStatus = { pid: null, coreSha256 };
  const calls: HelperRequest[] = [];
  const client: HelperClient = {
    status: async () => {
      calls.push({ method: "status" });
      return state;
    },
    start: async (configText) => {
      calls.push({ method: "start", configText });
      if (!coreSha256) throw new Error("Paired Core is unavailable");
      state = { ...state, pid };
      return { pid, coreSha256 };
    },
    connectController: () => {
      throw new Error("Mock controller is unavailable");
    },
    reload: async (configText) => {
      calls.push({ method: "reload", configText });
    },
    stop: async () => {
      calls.push({ method: "stop" });
      state = { ...state, pid: null };
    },
    logs: async () => {
      calls.push({ method: "logs" });
      return "";
    },
    close: () => {
      state = { ...state, pid: null };
    },
  };
  return { client, calls };
}
