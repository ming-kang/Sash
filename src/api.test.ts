import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MihomoApi } from "./api.js";

/**
 * Read the query out of a `.../ui/#/setup?a=b` deep-link the way the dashboard
 * does: Vue Router splits on `&`/`=` and decodes with decodeURIComponent.
 */
function setupQuery(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of url.slice(url.indexOf("?") + 1).split("&")) {
    const [key, value] = pair.split("=");
    if (key) out[key] = decodeURIComponent(value ?? "");
  }
  return out;
}

describe("MihomoApi.uiUrl", () => {
  it("builds a credential-free dashboard URL", () => {
    assert.equal(new MihomoApi("127.0.0.1:9090", "s3cr3t").uiUrl(), "http://127.0.0.1:9090/ui/");
  });

  it("falls back to the default controller when none is configured", () => {
    assert.equal(new MihomoApi("", "").uiUrl(), "http://127.0.0.1:9090/ui/");
  });

  it("rewrites wildcard binds to a reachable loopback address", () => {
    // 0.0.0.0 is a listen target, not something a browser can open.
    assert.equal(new MihomoApi("0.0.0.0:9090", "s").uiUrl(), "http://127.0.0.1:9090/ui/");
    assert.equal(new MihomoApi("[::]:9090", "s").uiUrl(), "http://[::1]:9090/ui/");
  });

  it("preserves an explicit IPv6 loopback controller", () => {
    assert.equal(new MihomoApi("[::1]:9090", "s").uiUrl(), "http://[::1]:9090/ui/");
  });
});

describe("MihomoApi.dashboardAuthUrl", () => {
  it("targets the dashboard's setup deep-link on the hash route", () => {
    const url = new MihomoApi("127.0.0.1:9090", "abc").dashboardAuthUrl();
    assert.ok(url.startsWith("http://127.0.0.1:9090/ui/#/setup?"), url);
    assert.deepEqual(setupQuery(url), { hostname: "127.0.0.1", port: "9090", secret: "abc" });
  });

  it("omits the protocol so the dashboard reuses the one the page was served over", () => {
    const query = setupQuery(new MihomoApi("127.0.0.1:9090", "abc").dashboardAuthUrl());
    assert.equal(query.http, undefined);
    assert.equal(query.https, undefined);
  });

  it("rewrites wildcard binds so the browser gets a connectable host", () => {
    const v4 = new MihomoApi("0.0.0.0:9090", "s").dashboardAuthUrl();
    const v6 = new MihomoApi("[::]:9090", "s").dashboardAuthUrl();
    assert.equal(setupQuery(v4).hostname, "127.0.0.1");
    assert.equal(setupQuery(v6).hostname, "[::1]");
  });

  it("keeps an explicit port that URL normalisation would otherwise drop", () => {
    const url = new MihomoApi("example.com:80", "s").dashboardAuthUrl();
    assert.equal(setupQuery(url).port, "80");
  });

  it("round-trips secrets containing URL, HTML and replacement-pattern metacharacters", () => {
    // The previous implementation spliced the secret into a <script> block with
    // String.replace, so `$&` expanded to the placeholder and `</script>` broke
    // out of the tag entirely.
    const secrets = [
      "a&b=c",
      "a</script><script>alert(1)</script>",
      "abc$&def",
      "x$`y",
      "x#y",
      "a b",
      'a"b',
      "p/q?r",
    ];
    for (const secret of secrets) {
      const url = new MihomoApi("127.0.0.1:9090", secret).dashboardAuthUrl();
      assert.equal(setupQuery(url).secret, secret, secret);
    }
  });

  it("percent-encodes spaces instead of form-encoding them", () => {
    // Vue Router decodes with decodeURIComponent, which leaves `+` untouched.
    const url = new MihomoApi("127.0.0.1:9090", "a b").dashboardAuthUrl();
    assert.ok(url.includes("secret=a%20b"), url);
    assert.ok(!url.includes("+"), url);
  });
});
