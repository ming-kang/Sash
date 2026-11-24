import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { it } from "vitest";
import { createIpcHelperClient } from "./ipc.js";

const binary = process.env.SASH_GO_CONTRACT_BINARY;

it.skipIf(!binary)(
  "exchanges frames with the Go helper using the unchanged TS IPC client",
  async () => {
    assert.ok(binary && path.isAbsolute(binary));
    const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "sash-go-ipc-"));
    try {
      const bin = path.join(root, "bin");
      const work = path.join(root, "work");
      await Promise.all([mkdir(bin), mkdir(work)]);
      const endpoint =
        process.platform === "win32"
          ? `\\\\.\\pipe\\${path.basename(root)}`
          : path.join(root, "ipc");
      const child = spawn(binary, ["--contract", bin, work, endpoint], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      const exit = once(child, "close");
      const lines = createInterface({ input: child.stdout });
      try {
        const ready = await Promise.race([once(lines, "line"), exit]);
        assert.deepEqual(ready, ["ready"]);
        const client = createIpcHelperClient(endpoint);
        try {
          const [status, logs] = await Promise.all([client.status(), client.logs()]);
          assert.deepEqual(status, { pid: null, coreSha256: null });
          assert.equal(logs, "");
          await assert.rejects(
            client.start("tun: {enable: true}"),
            /Paired Core is missing or invalid/,
          );
          await assert.rejects(client.reload("tun: {enable: true}"), /No privileged Core/);
          await client.stop();
          assert.deepEqual(await client.status(), status);
          const controller = client.connectController();
          controller.resume();
          await once(controller, "end");
          controller.destroy();
        } finally {
          client.close();
        }
      } finally {
        lines.close();
        child.kill();
        await exit;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
