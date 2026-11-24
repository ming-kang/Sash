import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { it } from "vitest";
import * as ipc from "./ipc.js";
import { HELPER_CONTROLLER_PREFACE } from "./protocol.js";

interface FakeTransport {
  stream: Duplex;
  written: Buffer[];
}

function fakeTransport(made: FakeTransport[]): Duplex {
  const written: Buffer[] = [];
  const stream = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      written.push(Buffer.from(chunk));
      cb();
    },
  });
  made.push({ stream, written });
  return stream;
}

async function waitFor(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function tempEndpoint(): Promise<{ endpoint: string; cleanup(): Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sash-ipc-"));
  return {
    endpoint:
      process.platform === "win32"
        ? `\\\\.\\pipe\\sash-ipc-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
        : path.join(root, "ipc.sock"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

it("no longer exposes a process-global transport factory", () => {
  assert.equal("setIpcTransportFactory" in ipc, false);
});

it("scopes a custom connect transport to its own client for request and controller links", async () => {
  const { endpoint, cleanup } = await tempEndpoint();
  // A real libuv listener: any client that reaches it provably used the
  // default transport rather than a factory leaked through global state.
  const serverSockets: net.Socket[] = [];
  const firstBytes: number[] = [];
  const server = net.createServer((socket) => {
    serverSockets.push(socket);
    socket.once("data", (chunk: Buffer) => firstBytes.push(chunk[0] ?? -1));
    socket.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        if (!line.startsWith("{")) continue;
        const request = JSON.parse(line) as { method?: string };
        if (request.method === "status") {
          socket.write(`${JSON.stringify({ ok: true, value: { pid: null, coreSha256: null } })}\n`);
        }
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.once("listening", resolve);
      server.listen(endpoint);
    });

    // Client A: custom per-client transport factory.
    const clientATransports: FakeTransport[] = [];
    const clientA = ipc.createIpcHelperClient(endpoint, 5_000, {
      connect: () => fakeTransport(clientATransports),
    });
    assert.equal(clientATransports.length, 1);

    // The request link writes into A's own fake transport.
    const statusA = clientA.status();
    await waitFor(() => (clientATransports[0]?.written.length ?? 0) > 0);
    assert.match(
      Buffer.concat(clientATransports[0]?.written ?? []).toString(),
      /"method":"status"/,
    );

    // The controller link opens a SECOND transport through the same factory
    // and writes the controller preface to it — not to the request socket.
    const controllerA = clientA.connectController();
    assert.equal(clientATransports.length, 2);
    assert.equal(controllerA, clientATransports[1]?.stream);
    await waitFor(() => (clientATransports[1]?.written.length ?? 0) > 0);
    assert.deepEqual(clientATransports[1]?.written[0], Buffer.from([HELPER_CONTROLLER_PREFACE]));

    // Client B: a different factory — A's transports stay untouched.
    const clientBTransports: FakeTransport[] = [];
    const clientB = ipc.createIpcHelperClient(endpoint, 5_000, {
      connect: () => fakeTransport(clientBTransports),
    });
    assert.equal(clientBTransports.length, 1);
    assert.equal(clientATransports.length, 2);

    // Client C: no factory. It must still use the default libuv transport —
    // if a global factory leaked, it would write to A's fake and the real
    // server would never answer.
    const clientC = ipc.createIpcHelperClient(endpoint, 5_000);
    assert.deepEqual(await clientC.status(), { pid: null, coreSha256: null });
    const controllerC = clientC.connectController();
    await waitFor(() => firstBytes.length >= 2);
    assert.deepEqual(firstBytes.sort(), [0, "{".charCodeAt(0)]);
    assert.equal(clientATransports.length, 2);
    assert.equal(clientBTransports.length, 1);

    controllerA.destroy();
    controllerC.destroy();
    clientA.close();
    clientB.close();
    clientC.close();
    await assert.rejects(statusA, /disconnected/);
  } finally {
    for (const socket of serverSockets) socket.destroy();
    server.close();
    await cleanup();
  }
});

it("runs options.verifyEndpoint before each transport is opened", async () => {
  const { endpoint, cleanup } = await tempEndpoint();
  const transports: FakeTransport[] = [];
  const seen: string[] = [];
  const client = ipc.createIpcHelperClient(endpoint, 1_000, {
    verifyEndpoint: (candidate) => seen.push(candidate),
    connect: () => fakeTransport(transports),
  });
  try {
    assert.deepEqual(seen, [endpoint]);
    const controller = client.connectController();
    assert.deepEqual(seen, [endpoint, endpoint]);
    controller.destroy();
  } finally {
    client.close();
    await cleanup();
  }
});
