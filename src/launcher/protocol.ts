import type { Socket } from "node:net";
import { z } from "zod";

export const CORE_SHA256 = /^[a-f0-9]{64}$/;
export const MAX_HELPER_FRAME = 20 * 1024 * 1024;
export const HELPER_IDLE_MS = 15_000;
export const HELPER_CONTROLLER_PREFACE = 0;
export const HELPER_RELOAD_TIMEOUT_MS = 180_000;
export class HelperReloadTimeoutError extends Error {}
const configTextSchema = z
  .string()
  .min(1)
  .max(8 * 1024 * 1024);
export const helperLaunchSchema = z.strictObject({
  pid: z.number().int().positive(),
  coreSha256: z.string().regex(CORE_SHA256),
});
export const helperRequestSchema = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("status") }),
  z.strictObject({
    method: z.literal("start"),
    configText: configTextSchema,
  }),
  z.strictObject({ method: z.literal("reload"), configText: configTextSchema }),
  z.strictObject({ method: z.literal("stop") }),
  z.strictObject({ method: z.literal("logs") }),
]);

export const helperStatusSchema = z.strictObject({
  pid: z.number().int().positive().nullable(),
  coreSha256: z.string().regex(CORE_SHA256).nullable(),
});

export type HelperRequest = z.output<typeof helperRequestSchema>;
export type HelperStatus = z.output<typeof helperStatusSchema>;
export type HelperLaunch = z.output<typeof helperLaunchSchema>;

export interface HelperClient {
  status(): Promise<HelperStatus>;
  start(configText: string): Promise<HelperLaunch>;
  connectController(): Socket;
  reload(configText: string): Promise<void>;
  stop(): Promise<void>;
  logs(): Promise<string>;
  close(): void;
}

export function validHelperEndpoint(endpoint: string, platform = process.platform): boolean {
  return platform === "win32"
    ? /^\\\\\.\\pipe\\[a-z0-9._-]+$/i.test(endpoint)
    : endpoint.startsWith("/") && !endpoint.includes("\0");
}
