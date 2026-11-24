import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { sashLayout } from "./paths.js";
import {
  describeTunHelper,
  type TunPlatform,
  TunService,
  unsupportedTunPlatform,
} from "./tun-service.js";

const layout = sashLayout(fs.mkdtempSync(path.join(os.tmpdir(), "sash-tun-service-")));

function platform(inspect: TunPlatform["inspect"], extra: Partial<TunPlatform> = {}): TunPlatform {
  return { ...unsupportedTunPlatform(), mechanism: "service", inspect, ...extra };
}

describe("TunService.status", () => {
  it("reports the mechanism, state and reason", async () => {
    const service = new TunService(
      platform(async () => ({
        state: "stale",
        detail: "the TUN service serves another data folder",
      })),
      layout,
    );
    assert.deepEqual((await service.status(true, undefined)).privilege, {
      mechanism: "service",
      state: "stale",
      detail: "the TUN service serves another data folder",
    });
  });

  it("reports an unsupported platform", async () => {
    const status = await new TunService(unsupportedTunPlatform(), layout).status(false, undefined);
    assert.equal(status.supported, false);
    assert.equal(status.privilege.mechanism, null);
    assert.equal(describeTunHelper(status), "Not available on this platform");
  });

  it("reuses the cached inspection for polling readers; fresh readers bypass it", async () => {
    let calls = 0;
    const service = new TunService(
      platform(async () => ({ state: calls++ === 0 ? "ready" : "missing" })),
      layout,
    );
    assert.equal((await service.status(false, undefined)).privilege.state, "ready");
    assert.equal((await service.status(false, undefined)).privilege.state, "ready");
    assert.equal(calls, 1);
    assert.equal(
      (await service.status(false, undefined, { fresh: true })).privilege.state,
      "missing",
    );
    assert.equal(calls, 2);
  });

  it("invalidates the inspection cache after install, even when it fails", async () => {
    let installed = false;
    const service = new TunService(
      platform(async () => ({ state: installed ? "ready" : "missing" }), {
        install: async () => {
          installed = true;
          throw new Error("verification failed after install");
        },
      }),
      layout,
    );
    assert.equal((await service.status(false, undefined)).privilege.state, "missing");
    await assert.rejects(service.setInstalled(true), /verification failed/);
    assert.equal((await service.status(false, undefined)).privilege.state, "ready");
  });

  it("keeps reporting when the inspection throws", async () => {
    const service = new TunService(
      platform(async () => {
        throw new Error("helper probe failed");
      }),
      layout,
    );
    const status = await service.status(false, undefined);
    assert.equal(status.privilege.state, "unknown");
    assert.equal(status.privilege.detail, "helper probe failed");
  });
});

describe("TunService.checkReady", () => {
  it("names the command that fixes each state", async () => {
    const check = (state: "missing" | "stale" | "unknown") =>
      new TunService(
        platform(async () => ({ state, detail: "reason" })),
        layout,
      ).checkReady();
    await assert.rejects(
      check("missing"),
      /Install the TUN helper first: sash tun helper install \(reason\)/,
    );
    await assert.rejects(
      check("stale"),
      /Install the TUN helper again: sash tun helper install \(reason\)/,
    );
    await assert.rejects(check("unknown"), /Could not check the TUN helper \(reason\)/);
    await new TunService(
      platform(async () => ({ state: "ready" })),
      layout,
    ).checkReady();
    await assert.rejects(
      new TunService(unsupportedTunPlatform(), layout).checkReady(),
      /not available/,
    );
  });

  it("always inspects fresh", async () => {
    let state: "ready" | "missing" = "ready";
    const service = new TunService(
      platform(async () => ({ state })),
      layout,
    );
    await service.status(false, undefined);
    state = "missing";
    await assert.rejects(service.checkReady(), /Install the TUN helper first/);
  });
});

describe("describeTunHelper", () => {
  it("summarizes each state on one line", () => {
    const status = (
      state: "ready" | "missing" | "stale" | "unknown",
      detail: string | null = null,
    ) => ({
      supported: true,
      desired: false,
      applied: false,
      privilege: { mechanism: "capabilities" as const, state, detail },
    });
    assert.equal(describeTunHelper(status("ready")), "Ready (Core capabilities)");
    assert.equal(describeTunHelper(status("missing")), "Not installed");
    assert.equal(
      describeTunHelper(status("stale", "old protocol")),
      "Needs reinstall (old protocol)",
    );
    assert.equal(
      describeTunHelper(status("unknown", "getcap is not installed")),
      "Unknown (getcap is not installed)",
    );
  });
});
