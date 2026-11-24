import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { readSashPackageInfo } from "./package-info.js";
import { sashLayout } from "./paths.js";
import { TunService, type TunPlatform, unsupportedTunPlatform } from "./tun-service.js";

const layout = sashLayout(fs.mkdtempSync(path.join(os.tmpdir(), "sash-tun-service-")));

function platform(inspect: TunPlatform["inspect"]): TunPlatform {
  return { ...unsupportedTunPlatform(), supported: true, inspect };
}

describe("TunService.status", () => {
  it("surfaces the helper version and paired-core state", async () => {
    const service = new TunService(
      platform(async () => ({
        installed: true,
        helperVersion: readSashPackageInfo().version,
        coreSynced: true,
      })),
      layout,
    );
    const status = await service.status(false, undefined);
    assert.equal(status.privilege.version, readSashPackageInfo().version);
    assert.equal(status.privilege.coreSynced, true);
    assert.equal(status.privilege.needsReconsent, false);
  });

  it("reuses the cached inspection for polling readers; fresh readers bypass it", async () => {
    let calls = 0;
    const service = new TunService(
      platform(async () => ({ installed: calls++ === 0 })),
      layout,
    );
    assert.equal((await service.status(false, undefined)).privilege.installed, true);
    assert.equal((await service.status(false, undefined)).privilege.installed, true);
    assert.equal(calls, 1);
    assert.equal(
      (await service.status(false, undefined, { fresh: true })).privilege.installed,
      false,
    );
    assert.equal(calls, 2);
  });

  it("invalidates the inspection cache after install/uninstall", async () => {
    let calls = 0;
    const service = new TunService(
      {
        ...unsupportedTunPlatform(),
        supported: true,
        inspect: async () => ({ installed: ++calls > 1 }),
        install: async () => {},
      },
      layout,
    );
    assert.equal((await service.status(false, undefined)).privilege.installed, false);
    await service.setInstalled(true);
    assert.equal((await service.status(false, undefined)).privilege.installed, true);
    assert.equal(calls, 2);
  });

  it("keeps reporting when the inspection throws", async () => {
    const service = new TunService(
      platform(async () => {
        throw new Error("helper probe failed");
      }),
      layout,
    );
    const status = await service.status(false, undefined);
    assert.equal(status.privilege.installed, null);
    assert.equal(status.privilege.version, null);
  });
});
