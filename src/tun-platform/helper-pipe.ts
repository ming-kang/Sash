import net from "node:net";
import { z } from "zod";

export const HELPER_PIPE = "\\\\.\\pipe\\sash-tun";
/** Bumped together with protocolVersion in helper/server.go. */
export const HELPER_PROTOCOL = 2;

const helperGuardSchema = z.object({
  active: z.boolean(),
  device: z.string().optional(),
  interfaceIndex: z.number().int().nonnegative().optional(),
});
export type HelperGuard = z.output<typeof helperGuardSchema>;

const helperReplySchema = z.object({
  ok: z.boolean(),
  protocol: z.number().int(),
  home: z.string(),
  running: z.boolean(),
  pid: z.number().int().positive().optional(),
  guard: helperGuardSchema.optional(),
  error: z.string().optional(),
});
export type HelperReply = z.output<typeof helperReplySchema>;
export type HelperOp = "status" | "start" | "stop";
export interface HelperStartOptions {
  guard?: boolean;
  device?: string;
}
export type HelperRequest = (
  op: HelperOp,
  timeoutMs: number,
  start?: HelperStartOptions,
) => Promise<HelperReply>;

/** One request line per connection, answered by one reply line. */
export function requestHelper(
  op: HelperOp,
  timeoutMs: number,
  options: { pipe?: string; start?: HelperStartOptions } = {},
): Promise<HelperReply> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: options.pipe ?? HELPER_PIPE });
    let buffer = "";
    const timer = setTimeout(
      () => socket.destroy(new Error(`TUN helper did not answer ${op} within ${timeoutMs}ms`)),
      timeoutMs,
    );
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      const request: Record<string, unknown> = { op };
      if (op === "start" && options.start) {
        if (options.start.guard) request.guard = true;
        if (options.start.device) request.device = options.start.device;
      }
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        if (buffer.length > 64 * 1024) socket.destroy(new Error("TUN helper reply is too large"));
        return;
      }
      clearTimeout(timer);
      socket.end();
      try {
        resolve(helperReplySchema.parse(JSON.parse(buffer.slice(0, newline))));
      } catch {
        reject(new Error("TUN helper sent an invalid reply"));
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("close", () => {
      clearTimeout(timer);
      reject(new Error("TUN helper closed the connection without replying"));
    });
  });
}
