import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import YAML from "yaml";
import type { DaemonStatus } from "./contracts.js";
import { GEOX_MIRRORS, type GeneratedConfig } from "./mihomo-config.js";
import { useDaemonTestHarness } from "./testing/daemon-harness.js";

const GEODATA_FAILURE =
  'can\'t download MMDB: Get "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/country.mmdb": dial tcp 140.82.112.3:443: connectex: A connection attempt failed';

describe("daemon geodata mirror retry", () => {
  const h = useDaemonTestHarness();

  it("retries a geodata download failure through the mirrors and applies that configuration", async () => {
    const validated: Array<{ generated: GeneratedConfig; executable: string }> = [];
    await h.startServer({
      validateConfig: (generated, executable) => {
        validated.push({ generated, executable });
        if (validated.length === 1) {
          throw Object.assign(new Error("command failed"), {
            stderr: Buffer.from(GEODATA_FAILURE),
          });
        }
      },
    });

    const response = await h.apiRequest("/sash/core/start", { method: "POST" });
    assert.equal(response.statusCode, 200);
    assert.equal(validated.length, 2);
    assert.equal(validated[0]?.executable, h.layout.coreExe);
    assert.equal(validated[1]?.executable, h.layout.coreExe);

    const firstDoc = YAML.parse(validated[0]?.generated.yaml ?? "") as Record<string, unknown>;
    assert.equal("geox-url" in firstDoc, false);
    const retriedDoc = YAML.parse(validated[1]?.generated.yaml ?? "") as Record<string, unknown>;
    assert.deepEqual(retriedDoc["geox-url"], { ...GEOX_MIRRORS });

    const applied = h.instance?.lifecycle.configuration();
    assert.ok(applied, "the daemon must hold an applied configuration after the retry");
    assert.deepEqual(applied.generated, validated[1]?.generated);
    const status = (await h.apiRequest("/sash/daemon/status")).data as DaemonStatus;
    assert.equal(status.configuration.pending, false);

    const publishedPath = path.join(h.layout.root, "runtime", "config.yaml");
    assert.equal(fs.existsSync(publishedPath), true);
    const publishedText = fs.readFileSync(publishedPath, "utf8");
    assert.match(publishedText, /ghfast\.top/);
    const published = YAML.parse(publishedText) as Record<string, unknown>;
    assert.deepEqual(published["geox-url"], { ...GEOX_MIRRORS });
  });

  it("walks the mirror list when the first mirror also fails", async () => {
    const validated: GeneratedConfig[] = [];
    await h.startServer({
      validateConfig: (generated) => {
        validated.push(generated);
        if (validated.length <= 2) {
          throw Object.assign(new Error("command failed"), {
            stderr: Buffer.from(GEODATA_FAILURE),
          });
        }
      },
    });

    const response = await h.apiRequest("/sash/core/start", { method: "POST" });
    assert.equal(response.statusCode, 200);
    assert.equal(validated.length, 3);
    const second = YAML.parse(validated[1]?.yaml ?? "") as Record<string, unknown>;
    const third = YAML.parse(validated[2]?.yaml ?? "") as Record<string, unknown>;
    assert.match((second["geox-url"] as { geoip: string }).geoip, /ghfast\.top/);
    assert.match((third["geox-url"] as { geoip: string }).geoip, /gh-proxy\.com/);
    assert.equal(h.instance?.lifecycle.configuration()?.generated, validated[2]);
  });

  it("stops walking the mirror list when a mirror reports an ordinary configuration error", async () => {
    const validated: GeneratedConfig[] = [];
    await h.startServer({
      validateConfig: (generated) => {
        validated.push(generated);
        if (validated.length === 1) {
          throw Object.assign(new Error("command failed"), {
            stderr: Buffer.from(GEODATA_FAILURE),
          });
        }
        throw Object.assign(new Error("command failed"), {
          stderr: Buffer.from("rules[0] error: rule is invalid"),
        });
      },
    });

    const response = await h.apiRequest("/sash/core/start", { method: "POST" });
    assert.notEqual(response.statusCode, 200);
    assert.equal(validated.length, 2);
  });

  it("seeds the missing database itself when every mirror fails, then applies the original configuration", async () => {
    const validated: GeneratedConfig[] = [];
    const seeded: string[] = [];
    await h.startServer({
      validateConfig: (generated) => {
        validated.push(generated);
        if (validated.length <= 3) {
          throw Object.assign(new Error("command failed"), {
            stderr: Buffer.from(GEODATA_FAILURE),
          });
        }
      },
      seedGeodata: async (file) => {
        seeded.push(file);
        fs.writeFileSync(path.join(h.layout.root, file), "seeded database");
        return { file, source: "live" };
      },
    });

    const response = await h.apiRequest("/sash/core/start", { method: "POST" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(seeded, ["country.mmdb"]);
    assert.equal(validated.length, 4);
    const finalDoc = YAML.parse(validated[3]?.yaml ?? "") as Record<string, unknown>;
    assert.equal("geox-url" in finalDoc, false);
    assert.equal(h.instance?.lifecycle.configuration()?.generated, validated[3]);
  });

  it("seeds each missing database in turn", async () => {
    const geositeFailure =
      'can\'t download GeoSite: Get "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat": dial tcp: connectex: A connection attempt failed';
    const seeded: string[] = [];
    let validations = 0;
    await h.startServer({
      validateConfig: () => {
        validations += 1;
        if (validations <= 3) {
          throw Object.assign(new Error("command failed"), {
            stderr: Buffer.from(GEODATA_FAILURE),
          });
        }
        if (validations === 4) {
          throw Object.assign(new Error("command failed"), {
            stderr: Buffer.from(geositeFailure),
          });
        }
      },
      seedGeodata: async (file) => {
        seeded.push(file);
        fs.writeFileSync(path.join(h.layout.root, file), "seeded database");
        return { file, source: "pinned" };
      },
    });

    const response = await h.apiRequest("/sash/core/start", { method: "POST" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(seeded, ["country.mmdb", "geosite.dat"]);
    assert.equal(validations, 5);
  });

  it("surfaces the geodata failure when verified seeding fails too", async () => {
    const seeded: string[] = [];
    await h.startServer({
      validateConfig: () => {
        throw Object.assign(new Error("command failed"), {
          stderr: Buffer.from(GEODATA_FAILURE),
        });
      },
      seedGeodata: async (file) => {
        seeded.push(file);
        throw new Error("getaddrinfo ENOTFOUND github.com");
      },
    });

    const response = await h.apiRequest("/sash/core/start", { method: "POST" });
    assert.notEqual(response.statusCode, 200);
    assert.deepEqual(seeded, ["country.mmdb"]);
  });
});
