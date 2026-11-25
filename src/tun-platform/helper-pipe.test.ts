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

function testPipe(name: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\sash-tun-${name}-${process.pid}-${Date.now()}`
    : path.join(os.tmpdir(), `sash-tun-${name}-${process.pid}-${Date.now()}.sock`);
}

async function serve(
  pipe: string,
  answer: (request: string) => string | undefined,
): Promise<string[]> {
  const seen: string[] = [];
  const server = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      const request = chunk.toString();
      seen.push(request);
      const response = answer(request);
      if (response === undefined) socket.end();
      else socket.end(`${response}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(pipe, resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return seen;
}

describe("requestHelper", () => {
  it.skipIf(process.platform !== "win32")("exchanges one JSON line over the pipe", async () => {
    const pipe = testPipe("exchange");
    const payload = reply({ running: true, pid: 9 });
    const seen = await serve(pipe, () => JSON.stringify(payload));
    assert.deepEqual(await requestHelper("status", 2_000, { pipe }), payload);
    assert.deepEqual(seen, ['{"op":"status"}\n']);
  });

  it.skipIf(process.platform !== "win32")("sends guard and device on start", async () => {
    const pipe = testPipe("start");
    const seen = await serve(pipe, () => JSON.stringify(reply({ running: true, pid: 9 })));
    await requestHelper("start", 2_000, { pipe, start: { guard: true, device: "sashtun" } });
    assert.deepEqual(seen, ['{"op":"start","guard":true,"device":"sashtun"}\n']);
  });

  it.skipIf(process.platform !== "win32")("omits empty start options", async () => {
    const pipe = testPipe("plain-start");
    const seen = await serve(pipe, () => JSON.stringify(reply({ running: true, pid: 9 })));
    await requestHelper("start", 2_000, { pipe, start: {} });
    assert.deepEqual(seen, ['{"op":"start"}\n']);
  });

  it.skipIf(process.platform !== "win32")("parses the guard state of a reply", async () => {
    const pipe = testPipe("guard-reply");
    const payload = reply({
      guard: { active: true, device: "sashtun", interfaceIndex: 17 },
    });
    await serve(pipe, () => JSON.stringify(payload));
    const parsed = await requestHelper("status", 2_000, { pipe });
    assert.deepEqual(parsed.guard, { active: true, device: "sashtun", interfaceIndex: 17 });
  });

  it.skipIf(process.platform !== "win32")("rejects a malformed reply", async () => {
    const pipe = testPipe("malformed");
    await serve(pipe, () => JSON.stringify({ nope: true }));
    await assert.rejects(requestHelper("status", 2_000, { pipe }), /invalid reply/);
  });

  it.skipIf(process.platform !== "win32")(
    "rejects when the helper closes without a reply",
    async () => {
      const pipe = testPipe("silent");
      await serve(pipe, () => undefined);
      await assert.rejects(requestHelper("status", 2_000, { pipe }), /closed the connection/);
    },
  );

  it("fails fast when nothing listens", async () => {
    const pipe = testPipe("missing");
    await assert.rejects(requestHelper("status", 2_000, { pipe }), /ENOENT|ECONNREFUSED/);
  });
});
