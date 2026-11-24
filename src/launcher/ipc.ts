import { createConnection } from "node:net";
import { isPlainObject } from "../json-shape.js";
import {
  HELPER_CONTROLLER_PREFACE,
  HELPER_RELOAD_TIMEOUT_MS,
  type HelperClient,
  HelperReloadTimeoutError,
  type HelperRequest,
  helperLaunchSchema,
  helperStatusSchema,
  type IpcTransport,
  MAX_HELPER_FRAME,
  validHelperEndpoint,
} from "./protocol.js";

export interface IpcHelperClientOptions {
  /**
   * Runs synchronously before each transport is opened — once for the
   * request socket and again for every `connectController()` link.
   */
  verifyEndpoint?: (endpoint: string) => void;
  /**
   * Per-client transport factory. When set it opens BOTH the request socket
   * and every `connectController()` link, so a custom transport can never
   * leak into other clients through process-global state.
   */
  connect?: () => IpcTransport;
}

export function readHelperFrames(socket: IpcTransport, onFrame: (frame: unknown) => void): void {
  let chunks: Buffer[] = [];
  let size = 0;
  socket.on("data", (data: Buffer) => {
    for (let start = 0; start < data.length; ) {
      const newline = data.indexOf(10, start);
      const end = newline === -1 ? data.length : newline;
      const chunk = data.subarray(start, end);
      size += chunk.length;
      if (size > MAX_HELPER_FRAME) {
        socket.destroy(new Error("Helper frame is too large"));
        return;
      }
      chunks.push(chunk);
      if (newline === -1) return;
      try {
        onFrame(JSON.parse(Buffer.concat(chunks, size).toString("utf8")));
      } catch {
        socket.destroy(new Error("Invalid helper frame"));
        return;
      }
      size = 0;
      chunks = [];
      start = end + 1;
    }
  });
}

export function createIpcHelperClient(
  endpoint: string,
  timeoutMs = 10_000,
  options: IpcHelperClientOptions = {},
): HelperClient {
  if (!validHelperEndpoint(endpoint)) throw new Error("Expected a local helper pipe or socket");
  const { verifyEndpoint, connect } = options;
  const openTransport = (): IpcTransport => {
    verifyEndpoint?.(endpoint);
    return connect?.() ?? createConnection({ path: endpoint });
  };
  const socket = openTransport();
  let tail: Promise<unknown> = Promise.resolve();
  let pending: { resolve(value: unknown): void; reject(error: Error): void } | undefined;
  let failure: Error | undefined;
  const fail = (error: Error): void => {
    failure ??= error;
    pending?.reject(failure);
  };
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("Helper IPC disconnected")));
  readHelperFrames(socket, (frame) => {
    if (!pending || !isPlainObject(frame) || typeof frame.ok !== "boolean")
      throw new Error("Unexpected helper response");
    if (frame.ok) pending.resolve(frame.value);
    else if (frame.code === "reload-timeout")
      pending.reject(
        new HelperReloadTimeoutError("Privileged Core configuration reload timed out"),
      );
    else
      pending.reject(
        new Error(typeof frame.error === "string" ? frame.error : "Helper request failed"),
      );
    pending = undefined;
  });

  function request(message: HelperRequest, deadline = timeoutMs): Promise<unknown> {
    const result = tail.then(
      () =>
        new Promise<unknown>((resolve, reject) => {
          if (failure) return reject(failure);
          const frame = JSON.stringify(message);
          if (Buffer.byteLength(frame) > MAX_HELPER_FRAME)
            return reject(new Error("Helper request is too large"));
          const timer = setTimeout(
            () => socket.destroy(new Error("Helper IPC request timed out")),
            deadline,
          );
          pending = {
            resolve: (value) => {
              clearTimeout(timer);
              resolve(value);
            },
            reject: (error) => {
              clearTimeout(timer);
              reject(error);
            },
          };
          socket.write(`${frame}\n`);
        }),
    );
    tail = result.catch(() => undefined);
    return result;
  }

  return {
    status: async () => helperStatusSchema.parse(await request({ method: "status" })),
    start: async (configText) =>
      helperLaunchSchema.parse(await request({ method: "start", configText })),
    connectController() {
      const transport = openTransport();
      transport.write(Buffer.from([HELPER_CONTROLLER_PREFACE]));
      return transport;
    },
    reload: async (configText) => {
      await request({ method: "reload", configText }, HELPER_RELOAD_TIMEOUT_MS + 10_000);
    },
    stop: async () => {
      await request({ method: "stop" });
    },
    logs: async () => {
      const value = await request({ method: "logs" });
      if (typeof value !== "string") throw new Error("Invalid helper logs");
      return value;
    },
    close: () => socket.destroy(),
  };
}
