import assert from "node:assert/strict";
import http from "node:http";
import { it } from "node:test";
import { parseCoreYaml } from "./core-yaml.js";
import { fetchSubscriptionProfile, parseSubscriptionUserinfo } from "./mihomo-config.js";
import { parseProfileText } from "./profiles.js";

it("distinguishes raw and base64 share links without echoing credentials", async () => {
  const links =
    "vless://private-credential@example.test:443#node\nss://private-secret@example.test:8443";
  for (const text of [
    links,
    Buffer.from(links).toString("base64"),
    Buffer.from(links).toString("base64url"),
  ]) {
    assert.throws(
      () => parseProfileText(text),
      (error) =>
        error instanceof Error &&
        /share links/.test(error.message) &&
        !error.message.includes("private"),
    );
  }
  assert.deepEqual(
    parseProfileText('proxies: []\nrules: ["DOMAIN,example.test,DIRECT"]\n').proxies,
    [],
  );
  const server = http.createServer((_req, res) => res.end(Buffer.from(links).toString("base64")));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await assert.rejects(
      fetchSubscriptionProfile(`http://127.0.0.1:${address.port}`),
      /base64-encoded share links/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("bounds alias expansion for every Core YAML consumer", () => {
  const text = `a: &a [one, two, three, four, five, six, seven, eight, nine, ten]\nb: &b [${Array(10).fill("*a").join(",")} ]\nrules: [${Array(10).fill("*b").join(",")}]`;
  assert.throws(() => parseCoreYaml(text), /alias/i);
  assert.throws(() => parseProfileText(text), /alias/i);
});

it("keeps missing subscription quota values unknown while accepting explicit zero", () => {
  for (const header of [
    "upload=;download=0;total=10",
    "upload=0;download= ;total=10",
    "upload=0;download=0;total=",
  ])
    assert.equal(parseSubscriptionUserinfo(header), undefined);
  assert.deepEqual(parseSubscriptionUserinfo("upload=0;download=0;total=0;expire="), {
    upload: 0,
    download: 0,
    total: 0,
  });
});
