import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { MockAgent } from "undici";
import { mihomoAssetCandidates } from "./core.js";
import { writeInstallRecord } from "./core-install-record.js";
import { checkCoreUpdate } from "./core-update-check.js";
import { proxyAwareDispatcher } from "./http.js";
import { sashLayout } from "./paths.js";

for (const target of ["v1.0.0", "v2.0.0"]) {
  it(`checks Core ${target} using metadata without installing or initializing application state`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-core-check-"));
    const layout = sashLayout(root);
    writeInstallRecord({ coreVersion: "v1.0.0" }, layout);
    const saved = fs.readFileSync(layout.installFile);
    const agent = new MockAgent();
    agent.disableNetConnect();
    t.mock.method(proxyAwareDispatcher(), "dispatch", agent.dispatch.bind(agent));
    agent
      .get("https://github.com")
      .intercept({ path: "/MetaCubeX/mihomo/releases/latest" })
      .reply(302, "", {
        headers: { location: `https://github.com/MetaCubeX/mihomo/releases/tag/${target}` },
      });
    const name = mihomoAssetCandidates(target)[0];
    assert.ok(name);
    agent
      .get("https://api.github.com")
      .intercept({ path: `/repos/MetaCubeX/mihomo/releases/tags/${target}` })
      .reply(200, {
        assets: [
          {
            name,
            browser_download_url: `https://github.com/MetaCubeX/mihomo/releases/download/${target}/${name}`,
            size: 1024,
            digest: `sha256:${"1".repeat(64)}`,
          },
        ],
      });
    try {
      assert.deepEqual(await checkCoreUpdate(layout), {
        current: "v1.0.0",
        target,
        available: target !== "v1.0.0",
        asset: name,
      });
      assert.deepEqual(fs.readFileSync(layout.installFile), saved);
      assert.equal(fs.existsSync(layout.settingsFile), false);
      assert.equal(fs.existsSync(layout.coreExe), false);
      agent.assertNoPendingInterceptors();
    } finally {
      await agent.close();
      assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
}
