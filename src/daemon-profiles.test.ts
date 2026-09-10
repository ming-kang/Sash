import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import { describe, it } from "node:test";
import YAML from "yaml";
import { readState } from "./app-state.js";
import {
  parseDaemonStatus,
  parseProfileActionResponse,
  parseProfileContentResponse,
  parseProfilesIndex,
} from "./contracts.js";
import { useDaemonTestHarness } from "./testing/daemon-harness.js";
import { deferred } from "./testing/state.js";

const content = "proxies:\n  - name: node-a\n    type: direct\nrules: ['MATCH,DIRECT']\n";
describe("profile management API", () => {
  const h = useDaemonTestHarness();
  async function add(name: string, yaml = content) {
    const result = await h.apiRequest("/sash/profiles/import", {
      method: "POST",
      body: { name, content: yaml },
    });
    assert.equal(result.statusCode, 200);
    return parseProfileActionResponse(result.data).profile;
  }
  async function status() {
    return parseDaemonStatus((await h.apiRequest("/sash/daemon/status")).data);
  }

  it("imports and selects saved profiles without starting or rendering Core", async () => {
    await h.startServer();
    const a = await add("a");
    const b = await add("b");
    assert.equal(fs.existsSync(h.layout.configFile), false);
    assert.equal((await status()).core.running, false);
    const response = await h.apiRequest("/sash/profiles/active", {
      method: "PUT",
      body: { id: b.id },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(parseProfilesIndex((await h.apiRequest("/sash/profiles")).data).activeId, b.id);
    assert.notEqual(a.id, b.id);
    assert.equal(fs.existsSync(h.layout.configFile), false);
  });
  it("keeps running data and runtime epoch unchanged by rename and reorder", async () => {
    await h.startServer();
    const a = await add("a");
    const b = await add("b");
    assert.equal((await h.apiRequest("/sash/core/start", { method: "POST" })).statusCode, 200);
    const before = await status();
    const config = fs.readFileSync(h.layout.configFile, "utf8");
    await h.apiRequest(`/sash/profiles/${a.id}`, { method: "PATCH", body: { name: "renamed" } });
    await h.apiRequest("/sash/profiles/order", { method: "PUT", body: { ids: [b.id, a.id] } });
    const after = await status();
    assert.ok(after.revisions.state > before.revisions.state);
    assert.equal(after.revisions.runtime, before.revisions.runtime);
    assert.equal(after.configuration.pending, false);
    assert.equal(after.core.pid, before.core.pid);
    assert.equal(fs.readFileSync(h.layout.configFile, "utf8"), config);
  });
  it("preserves source YAML but never publishes alternate controllers or tunnels", async () => {
    await h.startServer();
    const source = `${content}external-controller-unix: /tmp/unowned.sock\nexternal-controller-pipe: unowned-pipe\ntunnels: ['tcp,0.0.0.0:27894,example.com:80,DIRECT']\n`;
    const profile = await add("managed endpoints", source);
    assert.equal((await h.apiRequest("/sash/core/start", { method: "POST" })).statusCode, 200);
    const published = YAML.parse(fs.readFileSync(h.layout.configFile, "utf8"));
    assert.equal(published["external-controller"], h.settings.controller);
    for (const key of ["external-controller-unix", "external-controller-pipe", "tunnels"]) {
      assert.equal(Object.hasOwn(published, key), false);
    }
    assert.equal(
      parseProfileContentResponse((await h.apiRequest(`/sash/profiles/${profile.id}/content`)).data)
        .content,
      source,
    );
  });
  it("rejects custom listeners before replacing the running configuration", async () => {
    await h.startServer();
    const profile = await add("listener source");
    assert.equal((await h.apiRequest("/sash/core/start", { method: "POST" })).statusCode, 200);
    const before = fs.readFileSync(h.layout.configFile, "utf8");
    const owner = (await status()).core.pid;
    const saved = await h.apiRequest(`/sash/profiles/${profile.id}/content`, {
      method: "PUT",
      body: {
        revision: profile.revision,
        content: `${content}listeners: [{name: public, type: http, listen: 0.0.0.0, port: 27894}]\n`,
      },
    });
    assert.equal(saved.statusCode, 200);
    const apply = await h.apiRequest("/sash/core/restart", { method: "POST" });
    assert.notEqual(apply.statusCode, 200);
    assert.match(JSON.stringify(apply.data), /Custom listeners are not supported/);
    assert.equal(fs.readFileSync(h.layout.configFile, "utf8"), before);
    assert.equal((await status()).core.pid, owner);
    assert.equal((await status()).configuration.pending, true);
  });
  it("keeps a saved selection pending until explicit Apply", async () => {
    await h.startServer();
    const a = await add("a");
    const b = await add("b", content.replace("node-a", "node-b"));
    await h.apiRequest("/sash/core/start", { method: "POST" });
    await h.apiRequest("/sash/profiles/active", { method: "PUT", body: { id: b.id } });
    assert.equal((await status()).configuration.appliedProfile?.id, a.id);
    assert.equal((await status()).configuration.pending, true);
    assert.match(fs.readFileSync(h.layout.configFile, "utf8"), /node-a/);
    assert.equal((await h.apiRequest("/sash/core/restart", { method: "POST" })).statusCode, 200);
    assert.equal((await status()).configuration.appliedProfile?.id, b.id);
    assert.equal((await status()).configuration.pending, false);
    assert.match(fs.readFileSync(h.layout.configFile, "utf8"), /node-b/);
  });
  it("requires an editor revision and rejects stale writes without losing newer data", async () => {
    await h.startServer();
    const profile = await add("a");
    const endpoint = `/sash/profiles/${profile.id}/content`;
    const read = parseProfileContentResponse((await h.apiRequest(endpoint)).data);
    assert.equal(
      (await h.apiRequest(endpoint, { method: "PUT", body: { content } })).statusCode,
      400,
    );
    const next = content.replace("node-a", "node-b");
    assert.equal(
      (
        await h.apiRequest(endpoint, {
          method: "PUT",
          body: { content: next, revision: read.revision },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await h.apiRequest(endpoint, { method: "PUT", body: { content, revision: read.revision } }))
        .statusCode,
      409,
    );
    assert.equal(parseProfileContentResponse((await h.apiRequest(endpoint)).data).content, next);
  });
  it("rejects unauthorized and malformed profile mutations", async () => {
    await h.startServer();
    const profile = await add("a");
    assert.equal(
      (await h.apiRequest(`/sash/profiles/${profile.id}`, { method: "DELETE", token: "" }))
        .statusCode,
      401,
    );
    assert.equal(
      (
        await h.apiRequest("/sash/profiles/import", {
          method: "POST",
          body: { name: "bad", content: "wrong: format" },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await h.apiRequest("/sash/profiles/order", {
          method: "PUT",
          body: { ids: [profile.id, profile.id] },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await h.apiRequest("/sash/profiles/active", { method: "PUT", body: { id: "999" } }))
        .statusCode,
      404,
    );
    assert.equal(
      parseProfilesIndex((await h.apiRequest("/sash/profiles")).data).profiles.length,
      1,
    );
  });
  it("does not let a partial request body block stop or health", async () => {
    await h.startServer();
    const socket = net.createConnection({ host: "127.0.0.1", port: h.boundPort });
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    try {
      socket.write(
        `POST /sash/profiles HTTP/1.1\r\nHost: 127.0.0.1:${h.boundPort}\r\nAuthorization: Bearer ${h.settings.daemonSecret}\r\nContent-Length: 100\r\n\r\n{`,
      );
      assert.equal((await h.apiRequest("/sash/core/stop", { method: "POST" })).statusCode, 204);
      assert.equal((await h.apiRequest("/sash/daemon/health")).statusCode, 200);
    } finally {
      socket.destroy();
    }
  });
  for (const shutdown of [false, true])
    it(`preserves profile downloads on Core stop and cancels them on daemon shutdown (shutdown=${shutdown})`, async () => {
      const entered = deferred();
      const release = deferred();
      let downloadSignal: AbortSignal | undefined;
      await h.startServer({
        fetchProfile: async (_url, signal) => {
          downloadSignal = signal;
          entered.resolve();
          await release.promise;
          return { yamlText: content, doc: {} };
        },
      });
      const pending = h
        .apiRequest("/sash/profiles", {
          method: "POST",
          body: { url: "https://example.test/profile" },
        })
        .then(
          (response) => response.statusCode,
          (error: unknown) => {
            assert.ok(shutdown);
            assert.equal((error as { code?: unknown }).code, "UND_ERR_SOCKET");
            return null;
          },
        );
      await entered.promise;
      assert.equal(
        (
          await h.apiRequest(shutdown ? "/sash/daemon/shutdown" : "/sash/core/stop", {
            method: "POST",
          })
        ).statusCode,
        204,
      );
      assert.equal(downloadSignal?.aborted, shutdown);
      release.resolve();
      const response = await pending;
      if (shutdown) assert.ok(response === null || response === 409);
      else assert.equal(response, 200);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(readState(h.layout)?.profiles.profiles.length, shutdown ? 0 : 1);
    });
});
