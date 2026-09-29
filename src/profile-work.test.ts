import assert from "node:assert/strict";
import { it } from "node:test";
import { renderConfig } from "./mihomo-config.js";
import { parseProfileOffThread, renderProfileOffThread } from "./profile-work.js";
import { testSettings } from "./testing/state.js";

it("parses and renders profiles off the event loop without changing YAML semantics", async () => {
  const text = "rules: [MATCH,DIRECT]\nproxies: []\n";
  const document = await parseProfileOffThread(text);
  const settings = testSettings();
  assert.deepEqual(
    await renderProfileOffThread(text, settings),
    renderConfig(document, settings, "subscription"),
  );
  await assert.rejects(parseProfileOffThread("- not an object"), /configuration document/);
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
