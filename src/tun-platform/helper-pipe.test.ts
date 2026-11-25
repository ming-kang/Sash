import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it, onTestFinished } from "vitest";
import { sashLayout } from "../paths.js";
import { HELPER_PROTOCOL, type HelperReply, requestHelper } from "./helper-pipe.js";

const layout = sashLayout("C:\\Users\\Dev User\\AppData\\Local\\Sash");

function reply(patch: Partial<HelperReply> = {}): HelperReply {
  return { ok: true, protocol: HELPER_PROTOCOL, home: layout.root, running: false, ...patch };
}

describe("requestHelper", () => {
  it.skipIf(process.platform !== "win32")("exchanges one JSON line over the pipe", async () => {
    const pipe = `\\\\.\\pipe\\sash-tun-test-${process.pid}-${Date.now()}`;
    const seen: string[] = [];
    const server = net.createServer((socket) => {
      socket.once("data", (chunk) => {
        seen.push(chunk.toString());
        socket.end(`${JSON.stringify(reply({ running: true, pid: 9 }))}\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(pipe, resolve));
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    assert.deepEqual(await requestHelper("status", 2_000, pipe), reply({ running: true, pid: 9 }));
    assert.deepEqual(seen, ['{"op":"status"}\n']);
  });

  it("fails fast when nothing listens", async () => {
    const pipe =
      process.platform === "win32"
        ? `\\\\.\\pipe\\sash-tun-missing-${process.pid}`
        : path.join(os.tmpdir(), `sash-tun-missing-${process.pid}.sock`);
    await assert.rejects(requestHelper("status", 2_000, pipe), /ENOENT|ECONNREFUSED/);
  });
});
