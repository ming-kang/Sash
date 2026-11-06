import assert from "node:assert/strict";
import { it } from "node:test";
import YAML from "yaml";
import { GEOX_MIRROR_SETS, PROFILE_DOWNLOAD_SIZE_LIMIT, renderConfig } from "./mihomo-config.js";
import {
  inspectProfileOffThread,
  renderGeodataMirrorsOffThread,
  renderProfileOffThread,
} from "./profile-work.js";
import { parseProfileText } from "./profiles.js";
import { testSettings } from "./testing/state.js";

it("parses and renders profiles off the event loop without changing YAML semantics", async () => {
  const text = "rules: [MATCH,DIRECT]\nproxies: []\n";
  assert.deepEqual(await inspectProfileOffThread(text), { proxyCount: 0 });
  const settings = testSettings();
  assert.deepEqual(
    await renderProfileOffThread(text, settings),
    renderConfig(parseProfileText(text), settings, "subscription"),
  );
  await assert.rejects(inspectProfileOffThread("- not an object"), /configuration document/);
  const large =
    "rules:\n" +
    Array.from({ length: 20_000 }, (_, i) => `  - DOMAIN-SUFFIX,example${i}.test,DIRECT\n`).join(
      "",
    );
  let completed = false;
  const processing = renderProfileOffThread(large, settings).then((value) => {
    completed = true;
    return value;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(completed, false, "the HTTP event loop must advance while YAML is processed");
  assert.ok((await processing).yaml.includes("example19999.test"));
});

it("rewrites prepared mirror variants without changing metadata, key order or the source cache", async () => {
  const settings = testSettings();
  const base = {
    proxies: [
      { name: "one", type: "direct" },
      { name: "two", type: "direct" },
    ],
    rules: ["MATCH,DIRECT"],
  };
  const text = YAML.stringify(base);
  const baseline = await renderProfileOffThread(text, settings);
  for (const source of ["default", "subscription"] as const) {
    const generated = { ...renderConfig(base, settings, source), proxyCount: 23 };
    const document = YAML.parse(generated.yaml);
    for (const mirrors of GEOX_MIRROR_SETS) {
      const retried = await renderGeodataMirrorsOffThread(generated, mirrors);
      assert.deepEqual(YAML.parse(retried.yaml), { ...document, "geox-url": mirrors });
      assert.equal(retried.proxyCount, generated.proxyCount);
      assert.equal(retried.source, source);
      assert.deepEqual(
        await renderGeodataMirrorsOffThread(retried, mirrors),
        retried,
        "an already-attempted mirror must stay byte-identical for retry de-duplication",
      );
    }
  }
  assert.deepEqual(await renderProfileOffThread(text, settings), baseline);
  assert.deepEqual(await inspectProfileOffThread(text), { proxyCount: 2 });
});

it("replaces profile-supplied geodata URLs without reapplying managed settings", async () => {
  const settings = testSettings();
  const base = {
    "geox-url": {
      geoip: "https://profile.example/geoip.dat",
      mmdb: "https://profile.example/country.mmdb",
    },
    rules: ["MATCH,DIRECT"],
  };
  const generated = renderConfig(base, settings, "subscription");
  const retried = await renderGeodataMirrorsOffThread(generated, GEOX_MIRROR_SETS[0]);
  assert.deepEqual(YAML.parse(retried.yaml), {
    ...YAML.parse(generated.yaml),
    "geox-url": GEOX_MIRROR_SETS[0],
  });
  assert.deepEqual(YAML.parse(generated.yaml)["geox-url"], base["geox-url"]);
});

it("accepts generated YAML expanded beyond the profile limit without relaxing source limits", async () => {
  const prefix = "notes: ";
  const suffix = "\nproxies: []\nrules: [MATCH,DIRECT]\n";
  const text =
    prefix +
    "x".repeat(PROFILE_DOWNLOAD_SIZE_LIMIT - Buffer.byteLength(prefix + suffix) - 64) +
    suffix;
  assert.deepEqual(await inspectProfileOffThread(text), { proxyCount: 0 });
  const generated = await renderProfileOffThread(text, testSettings());
  assert.ok(Buffer.byteLength(generated.yaml) > PROFILE_DOWNLOAD_SIZE_LIMIT);
  const retried = await renderGeodataMirrorsOffThread(generated, GEOX_MIRROR_SETS[0]);
  assert.equal(retried.yaml.slice(0, generated.yaml.length), generated.yaml);
  assert.equal(retried.proxyCount, generated.proxyCount);
  assert.equal(retried.source, generated.source);
  assert.ok(retried.yaml.includes(GEOX_MIRROR_SETS[0].geoip));
  await assert.rejects(inspectProfileOffThread(generated.yaml), /no larger than 8 MiB/);
  assert.deepEqual(await inspectProfileOffThread(text), { proxyCount: 0 });
});
