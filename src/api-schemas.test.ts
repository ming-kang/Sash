import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  coreDelayBodySchema,
  profileAddBodySchema,
  profileContentBodySchema,
  profileImportBodySchema,
  profileRenameBodySchema,
  settingsPatchBodySchema,
  tunHelperBodySchema,
} from "./api-schemas.js";
import type { SettingsPatch } from "./contracts.js";

describe("daemon request body schemas", () => {
  it("requires a delay target name string and nothing else", () => {
    assert.deepEqual(coreDelayBodySchema.parse({ name: "节点 A" }), { name: "节点 A" });
    for (const body of [
      {},
      { name: 42 },
      { name: true },
      { name: null },
      { name: ["node"] },
      { name: "node", url: "https://example.test" },
    ])
      assert.equal(coreDelayBodySchema.safeParse(body).success, false, JSON.stringify(body));
  });

  it("types profile add fields while keeping each optional", () => {
    assert.deepEqual(profileAddBodySchema.parse({}), {});
    assert.deepEqual(
      profileAddBodySchema.parse({ url: "https://example.test", name: "sub", activate: true }),
      { url: "https://example.test", name: "sub", activate: true },
    );
    for (const body of [
      { url: 42 },
      { url: ["https://example.test"] },
      { name: 7 },
      { activate: "yes" },
      { activate: 1 },
    ])
      assert.equal(profileAddBodySchema.safeParse(body).success, false, JSON.stringify(body));
  });

  it("types profile import fields while keeping each optional", () => {
    assert.deepEqual(profileImportBodySchema.parse({}), {});
    assert.deepEqual(profileImportBodySchema.parse({ name: "sub", content: "proxies: []" }), {
      name: "sub",
      content: "proxies: []",
    });
    for (const body of [{ name: 7 }, { content: 9 }, { content: {} }])
      assert.equal(profileImportBodySchema.safeParse(body).success, false, JSON.stringify(body));
  });

  it("requires a positive integer revision for profile content writes", () => {
    assert.deepEqual(profileContentBodySchema.parse({ revision: 1 }), { revision: 1 });
    assert.deepEqual(profileContentBodySchema.parse({ content: "proxies: []", revision: 3 }), {
      content: "proxies: []",
      revision: 3,
    });
    for (const body of [
      {},
      { content: "proxies: []" },
      { revision: "1" },
      { revision: 0 },
      { revision: -2 },
      { revision: 1.5 },
      { revision: true },
      { content: 5, revision: 1 },
    ])
      assert.equal(profileContentBodySchema.safeParse(body).success, false, JSON.stringify(body));
  });

  it("types the profile rename name while keeping it optional", () => {
    assert.deepEqual(profileRenameBodySchema.parse({}), {});
    assert.deepEqual(profileRenameBodySchema.parse({ name: "renamed" }), { name: "renamed" });
    for (const body of [{ name: 42 }, { name: true }, { name: ["x"] }])
      assert.equal(profileRenameBodySchema.safeParse(body).success, false, JSON.stringify(body));
  });

  it("accepts only a known helper elevation mechanism", () => {
    assert.deepEqual(tunHelperBodySchema.parse({}), {});
    assert.deepEqual(tunHelperBodySchema.parse({ helperAuth: "sudo" }), { helperAuth: "sudo" });
    assert.equal(tunHelperBodySchema.safeParse({ helperAuth: "doas" }).success, false);
    assert.equal(tunHelperBodySchema.safeParse({ core: "C:/other.exe" }).success, false);
  });

  it("parses a settings patch that is assignable to SettingsPatch", () => {
    const patch: SettingsPatch = settingsPatchBodySchema.parse({
      expectedRevision: 0,
      mixedPort: 7890,
      allowLan: true,
      systemProxy: false,
      tun: { enable: true, stack: "gvisor", device: null },
    });
    assert.equal(patch.expectedRevision, 0);
    assert.equal(patch.mixedPort, 7890);
    assert.equal(patch.tun?.stack, "gvisor");
    const empty: SettingsPatch = settingsPatchBodySchema.parse({});
    assert.deepEqual(empty, {});
  });

  it("rejects settings patches with wrong primitive types or unknown fields", () => {
    for (const body of [
      { expectedRevision: "0" },
      { expectedRevision: -1 },
      { expectedRevision: 1.5 },
      { mixedPort: "7890" },
      { mixedPort: 0 },
      { mixedPort: 65_536 },
      { mixedPort: 1.5 },
      { mixedPort: true },
      { allowLan: "true" },
      { allowLan: 1 },
      { systemProxy: "no" },
      { systemProxy: 0 },
      { tun: "off" },
      { tun: { enable: "yes" } },
      { tun: { stack: "bogus" } },
      { daemonPort: 1234 },
      { controller: "127.0.0.1:9090" },
    ])
      assert.equal(settingsPatchBodySchema.safeParse(body).success, false, JSON.stringify(body));
  });
});
