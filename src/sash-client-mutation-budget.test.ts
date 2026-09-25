import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDaemonClient } from "./sash-client-node.js";
import { useDaemonTestHarness } from "./testing/daemon-harness.js";

const profile = "proxies: []\nrules: ['MATCH,DIRECT']\n";

describe("daemon mutation budgets", () => {
  const h = useDaemonTestHarness();
  it("lets a change queued behind a long validation finish instead of failing", async () => {
    let validationMs = 0;
    await h.startMockCore((req, res) => {
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

    validationMs = 6_000;
    const selected = client.activateProfile(b.id);
    await new Promise((resolve) => setTimeout(resolve, 200));
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
