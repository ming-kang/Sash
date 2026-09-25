import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDaemonClient } from "./sash-client-node.js";
import { useDaemonTestHarness } from "./testing/daemon-harness.js";

const profile = "proxies: []\nrules: ['MATCH,DIRECT']\n";

/**
 * A change that alters the core config is validated and reloaded before the
 * daemon answers, and every other change waits in the same mutation queue. A
 * client that gives up first reports a failure for a change that is already
 * committed — and often already live.
 */
describe("daemon mutation budgets", () => {
  const h = useDaemonTestHarness();
  it("lets a change queued behind a long validation finish instead of failing", async () => {
    let validationMs = 0;
    await h.startMockCore((req, res) => {
      // Stand-in Core controller: it answers a reload the moment it is asked to.
      req.resume();
      res.writeHead(204);
      res.end();
    });
    await h.startServer({
      validateConfig: async () => {
        if (validationMs) await new Promise((resolve) => setTimeout(resolve, validationMs));
      },
    });
    const client = createDaemonClient(h.boundPort, h.settings.daemonSecret);
    await client.startCore();
    const a = (await client.importProfile("A", profile)).profile;
    const b = (await client.importProfile("B", profile)).profile;

    // A validation slow enough to outlast a short default request budget: a
    // configuration test that fetches geodata through a mirror set, say.
    validationMs = 6_000;
    const selected = client.activateProfile(b.id);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // The rename itself never touches the core config, so it only waits here.
    const renamed = client.renameProfile(a.id, "A renamed");
    const [activate, rename] = await Promise.allSettled([selected, renamed]);
    assert.equal(activate.status, "fulfilled", "selecting a profile failed while validating it");
    assert.equal(rename.status, "fulfilled", "a rename failed while queued behind another change");

    const index = await client.listProfiles();
    assert.equal(index.activeId, b.id);
    assert.deepEqual(
      index.profiles.map((entry) => entry.name),
      ["A renamed", "B"],
    );
    const status = (await client.status()).configuration;
    assert.equal(status.appliedProfile?.id, b.id);
    assert.equal(status.pending, false);
  });
});
