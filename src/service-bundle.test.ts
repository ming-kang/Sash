import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import type { FetchResponse } from "./http.js";
import { sashLayout } from "./paths.js";
import { prepareServiceBundle } from "./service-bundle.js";

function response(data: string | Buffer, statusCode = 200, location?: string): FetchResponse {
  const bytes = Buffer.from(data);
  return {
    statusCode,
    headers: { location },
    buffer: async (limit) => {
      assert.ok(bytes.length <= limit);
      return bytes;
    },
    text: async () => bytes.toString(),
    discard: async () => {},
  };
}
async function temp(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sash-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test("remote profile preserves policy, converts proxy YAML, and exposes refresh outside wire JSON", async (t) => {
  const root = await temp(t);
  const doc = {
    udp: true,
    sniffer: {
      enable: true,
      "parse-pure-ip": true,
      sniff: {
        TLS: { ports: [443, 8443] },
        HTTP: { ports: [80, "8080-8880"], "override-destination": true },
        QUIC: { ports: [443, 8443] },
      },
      "skip-domain": ["+.example.org"],
    },
    tun: { enable: true, stack: "mixed", "strict-route": true },
    "proxy-providers": {
      x: {
        type: "http",
        url: "https://example.org/proxies?token=private",
        interval: 60,
        "health-check": { enable: true, url: "https://example.org/health", interval: 30 },
      },
    },
    "rule-providers": {
      y: {
        type: "http",
        url: "https://example.org/rules",
        interval: 120,
        format: "text",
        behavior: "domain",
      },
    },
  };
  const yaml = YAML.stringify(doc);
  const bundle = await prepareServiceBundle(yaml, sashLayout(root), {
    fetch: async (url) =>
      response(
        url.includes("proxies")
          ? "proxies:\n  - name: safe\n    type: direct\nsubscription-userinfo: private"
          : "+.example.org",
      ),
  });
  assert.equal(yaml, YAML.stringify(doc));
  assert.deepEqual(bundle.config.sniffer, doc.sniffer);
  assert.equal(bundle.refreshMs, 60_000);
  assert.equal(JSON.stringify(bundle).includes("refreshMs"), false);
  assert.equal(JSON.stringify(bundle).includes("token=private"), false);
  assert.deepEqual(JSON.parse(Buffer.from(bundle.assets[0]?.data ?? "", "base64").toString()), {
    proxies: [{ name: "safe", type: "direct" }],
  });
  const p = (bundle.config["proxy-providers"] as Record<string, Record<string, unknown>>).x;
  assert.ok(p);
  assert.equal(p.type, "file");
  assert.deepEqual(p["health-check"], doc["proxy-providers"].x["health-check"]);
});
test("file providers reject unsafe paths and ancestor links", async (t) => {
  const root = await temp(t);
  for (const source of [
    "../x",
    "/x",
    "C:/x",
    "\\\\server\\x",
    "providers/CON",
    "providers/a.",
    "providers/x:stream",
    "providers/%2e",
    "missing",
  ]) {
    await assert.rejects(
      prepareServiceBundle(
        YAML.stringify({ "proxy-providers": { x: { type: "file", path: source } } }),
        sashLayout(root),
      ),
      /missing or unsafe/,
    );
  }
  await mkdir(path.join(root, "real"));
  await writeFile(path.join(root, "real", "x.yaml"), "proxies: [{type: direct}]");
  try {
    await symlink(
      path.join(root, "real"),
      path.join(root, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.diagnostic("Symlink privilege unavailable");
      return;
    }
    throw error;
  }
  await assert.rejects(
    prepareServiceBundle(
      "proxy-providers: {x: {type: file, path: linked/x.yaml}}",
      sashLayout(root),
    ),
    /unsafe/,
  );
  const bundle = await prepareServiceBundle(
    "proxy-providers: {x: {type: file, path: real/x.yaml}}",
    sashLayout(root),
  );
  assert.match(bundle.assets[0]?.path ?? "", /^providers\/[a-f0-9]{64}\.json$/);
});
test("malformed proxy content cannot leak YAML diagnostic credentials", async (t) => {
  const root = await temp(t);
  for (const body of [
    "proxies: [secret-password",
    "proxies: null",
    "proxies: [null]",
    "proxies: [{name: missing-type}]",
    "proxies: []\nproxies: []",
  ]) {
    await assert.rejects(
      prepareServiceBundle(
        "proxy-providers: {x: {type: http, url: 'https://example.org/?secret'}}",
        sashLayout(root),
        { fetch: async () => response(body) },
      ),
      (error: Error) =>
        !error.message.includes("secret-password") && !error.message.includes("?secret"),
    );
  }
});
test("remote byte cap, shared absolute deadline, redirect restrictions and direct loopback", async (t) => {
  const root = await temp(t);
  const yaml =
    "rule-providers: {x: {type: http, url: 'http://127.0.0.1:18399/rules', format: text}}";
  let clock = 0;
  await assert.rejects(
    prepareServiceBundle(yaml, sashLayout(root), {
      now: () => clock,
      deadlineMs: 50,
      fetch: async (_url, options) => {
        assert.equal(options?.direct, true);
        assert.equal(options?.deadlineMs, 50);
        clock = 51;
        return response("+.example.org");
      },
    }),
    /deadline/,
  );
  await assert.rejects(
    prepareServiceBundle(yaml, sashLayout(root), {
      fetch: async () => response(Buffer.alloc(8 * 1024 * 1024 + 1)),
    }),
    /8 MiB/,
  );
  await assert.rejects(
    prepareServiceBundle(yaml, sashLayout(root), {
      fetch: async () => response("", 302, "https://example.org/rules"),
    }),
    /redirect/,
  );
});
test("missing trusted geodata metadata fails clearly and existing known-role files are bundled", async (t) => {
  const root = await temp(t);
  const yaml =
    "rules: [GEOIP,CN,DIRECT]\ndns: {fallback: [8.8.8.8], fallback-filter: {geoip: true, geosite: [reserved]}}";
  await assert.rejects(
    prepareServiceBundle(yaml, sashLayout(root), { listReleaseAssets: async () => [] }),
    /Trusted service geodata (country.mmdb|geosite.dat).*MetaCubeX/,
  );
  await writeFile(path.join(root, "country.mmdb"), "fixture");
  await writeFile(path.join(root, "geosite.dat"), "fixture");
  const bundle = await prepareServiceBundle(yaml, sashLayout(root));
  assert.equal(bundle.assets.length, 2);
});

test("trusted geodata uses only fixed release metadata, private cache, and bounded verified bytes", async (t) => {
  const root = await temp(t);
  const bytes = Buffer.from("trusted fixture");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  let downloads = 0;
  const options = {
    listReleaseAssets: async (repo: string, tag: string) => {
      assert.equal(repo, "MetaCubeX/meta-rules-dat");
      assert.equal(tag, "latest");
      return [
        {
          name: "country.mmdb",
          size: bytes.length,
          digest,
          browser_download_url: "https://untrusted.invalid/ignored",
        },
      ];
    },
    downloadReleaseAsset: async (opts: import("./github.js").DownloadOptions) => {
      downloads++;
      assert.equal(opts.repo, "MetaCubeX/meta-rules-dat");
      assert.deepEqual(opts.candidates, ["country.mmdb"]);
      assert.ok((opts.deadlineMs ?? Infinity) <= 90_000);
      await writeFile(opts.dest, bytes);
      return "country.mmdb";
    },
  };
  const yaml = 'rules: ["GEOIP,CN,DIRECT"]';
  const bundle = await prepareServiceBundle(yaml, sashLayout(root), options);
  assert.deepEqual(Buffer.from(bundle.assets[0]?.data ?? "", "base64"), bytes);
  assert.deepEqual(await readFile(path.join(root, "service-assets", "country.mmdb")), bytes);
  if (process.platform !== "win32")
    assert.equal(
      (await stat(path.join(root, "service-assets", "country.mmdb"))).mode & 0o777,
      0o600,
    );
  await prepareServiceBundle(yaml, sashLayout(root), {
    listReleaseAssets: async () => {
      throw new Error("must use cache");
    },
  });
  assert.equal(downloads, 1);
  await assert.rejects(readFile(path.join(root, "country.mmdb")), { code: "ENOENT" });
});

test("geodata trust failures never publish cache files or leak remote diagnostics", async (t) => {
  const root = await temp(t);
  for (const asset of [
    { size: 1, digest: "" },
    { size: 64 * 1024 * 1024 + 1, digest: `sha256:${"a".repeat(64)}` },
    { size: 1, digest: `sha256:${"a".repeat(64)}` },
  ]) {
    await assert.rejects(
      prepareServiceBundle('rules: ["GEOIP,CN,DIRECT"]', sashLayout(root), {
        listReleaseAssets: async () => [
          { name: "country.mmdb", browser_download_url: "https://private.invalid/token", ...asset },
        ],
        downloadReleaseAsset: async (opts) => {
          await writeFile(opts.dest, "x");
          return "country.mmdb";
        },
      }),
      (error: Error) =>
        /official SHA-256/.test(error.message) && !error.message.includes("private.invalid"),
    );
    await assert.rejects(readFile(path.join(root, "service-assets", "country.mmdb")), {
      code: "ENOENT",
    });
  }
});

test("cache junction rejects without writes outside SASH_HOME", async (t) => {
  const root = await temp(t);
  const outside = await temp(t);
  try {
    await symlink(
      outside,
      path.join(root, "service-assets"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Symlink privilege unavailable");
      return;
    }
    throw error;
  }
  await assert.rejects(
    prepareServiceBundle('rules: ["GEOIP,CN,DIRECT"]', sashLayout(root), {
      listReleaseAssets: async () => {
        throw new Error("must not fetch");
      },
    }),
    /symlinks|junctions|Trusted service geodata/,
  );
  await assert.rejects(readFile(path.join(outside, "country.mmdb")), { code: "ENOENT" });
});

test("geoip false and proxy names are not geodata references; provider auth stays unprivileged", async (t) => {
  const root = await temp(t);
  const bundle = await prepareServiceBundle(
    YAML.stringify({
      dns: { fallback: ["8.8.8.8"], "fallback-filter": { geoip: false, "geoip-code": "CN" } },
      "proxy-providers": {
        GEOIP: {
          type: "http",
          url: "https://example.org/p",
          header: { Authorization: ["Bearer private"] },
          "health-check": { enable: false },
        },
      },
    }),
    sashLayout(root),
    {
      fetch: async (_url, opts) => {
        assert.equal(opts?.headers?.Authorization, "Bearer private");
        return response("proxies: [{type: direct, name: GEOIP}]");
      },
      listReleaseAssets: async () => {
        throw new Error("must not fetch geo");
      },
    },
  );
  assert.equal(bundle.assets.length, 1);
  assert.equal(JSON.stringify(bundle).includes("Bearer private"), false);
});

test("ASN role maps only to the official GeoLite2-ASN plain asset", async (t) => {
  const root = await temp(t);
  const data = Buffer.from("ASN fixture");
  const bundle = await prepareServiceBundle('rules: ["IP-ASN,13335,DIRECT"]', sashLayout(root), {
    listReleaseAssets: async () => [
      {
        name: "GeoLite2-ASN.mmdb",
        size: data.length,
        digest: `sha256:${createHash("sha256").update(data).digest("hex")}`,
        browser_download_url: "ignored",
      },
    ],
    downloadReleaseAsset: async (opts) => {
      assert.deepEqual(opts.candidates, ["GeoLite2-ASN.mmdb"]);
      assert.equal(path.basename(opts.dest), "ASN.mmdb");
      await writeFile(opts.dest, data);
      return "GeoLite2-ASN.mmdb";
    },
  });
  assert.equal(bundle.assets[0]?.path, "ASN.mmdb");
});

test("rule YAML and JSON escapes are normalized before geo requirements; sources stay unchanged", async (t) => {
  const root = await temp(t);
  const profile =
    "rule-providers: {x: {type: file, path: rules.yaml, behavior: classical, format: yaml}}";
  await writeFile(path.join(root, "profile.yaml"), profile);
  for (const body of [
    String.raw`{"payload":["GEO\u0049P,CN"]}`,
    String.raw`payload: ["GEO\u0049P,CN"]`,
  ]) {
    await writeFile(path.join(root, "rules.yaml"), body);
    await assert.rejects(
      prepareServiceBundle(profile, sashLayout(root), { listReleaseAssets: async () => [] }),
      /Trusted service geodata country.mmdb/,
    );
    await writeFile(path.join(root, "country.mmdb"), "fixture");
    const bundle = await prepareServiceBundle(profile, sashLayout(root));
    assert.deepEqual(JSON.parse(Buffer.from(bundle.assets[0]?.data ?? "", "base64").toString()), {
      payload: ["GEOIP,CN"],
    });
    assert.equal(await readFile(path.join(root, "rules.yaml"), "utf8"), body);
    assert.equal(await readFile(path.join(root, "profile.yaml"), "utf8"), profile);
    await rm(path.join(root, "country.mmdb"));
  }
});

test("rule payload bounds, ambiguous text and classical MRS fail closed", async (t) => {
  const root = await temp(t);
  for (const [format, body] of [
    ["yaml", "payload: null"],
    ["yaml", "payload: [1]"],
    ["yaml", `payload: [${"x".repeat(8193)}]`],
    ["text", String.raw`GEO\u0049P,CN`],
    ["mrs", "binary"],
  ]) {
    await assert.rejects(
      prepareServiceBundle(
        YAML.stringify({
          "rule-providers": {
            x: { type: "http", url: "https://example.org/r", behavior: "classical", format },
          },
        }),
        sashLayout(root),
        { fetch: async () => response(body ?? "") },
      ),
      /payload|Ambiguous|MRS/,
    );
  }
  const text = await prepareServiceBundle(
    "rule-providers: {x: {type: http, url: 'https://example.org/r', format: text, behavior: domain}}",
    sashLayout(root),
    { fetch: async () => response("\ufeff# comment\r\n  +.example.org  \r\n") },
  );
  assert.equal(Buffer.from(text.assets[0]?.data ?? "", "base64").toString(), "+.example.org\n");
  const binary = Buffer.from([0, 255, ...Buffer.from("GEOIP")]);
  const mrs = await prepareServiceBundle(
    "rule-providers: {x: {type: http, url: 'https://example.org/r', format: mrs, behavior: domain}}",
    sashLayout(root),
    { fetch: async () => response(binary) },
  );
  assert.deepEqual(Buffer.from(mrs.assets[0]?.data ?? "", "base64"), binary);
});
