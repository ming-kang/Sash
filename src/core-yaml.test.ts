import assert from "node:assert/strict";
import http from "node:http";
import { it } from "node:test";
import { fetchSubscriptionProfile, parseSubscriptionUserinfo } from "./mihomo-config.js";

it("parses core-format subscription documents with their metadata headers", async () => {
  const text = 'proxies: []\nrules: ["DOMAIN,example.test,DIRECT"]\n';
  const server = http.createServer((_req, res) => {
    res.setHeader("subscription-userinfo", "upload=0;download=1;total=2");
    res.setHeader("profile-update-interval", "12");
    res.end(text);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const fetched = await fetchSubscriptionProfile(`http://127.0.0.1:${address.port}`);
    assert.deepEqual(fetched.doc, { proxies: [], rules: ["DOMAIN,example.test,DIRECT"] });
    assert.deepEqual(fetched.subInfo, { upload: 0, download: 1, total: 2 });
    assert.equal(fetched.intervalHours, 12);
    assert.equal(fetched.yamlText, text);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("rejects a subscription body that is not a core configuration document", async () => {
  const server = http.createServer((_req, res) => res.end("scalar"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await assert.rejects(
      fetchSubscriptionProfile(`http://127.0.0.1:${address.port}`),
      /not a core configuration document/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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
