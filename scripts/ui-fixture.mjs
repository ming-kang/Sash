import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testProfile, testStatus } from "../src/test-state.test.ts";

/** Static assets only: unmocked API requests can never reach a running daemon. */
export async function serveUi() {
  const root = fileURLToPath(new URL("../dist/ui", import.meta.url));
  const mime = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".woff2": "font/woff2",
    ".svg": "image/svg+xml",
  };
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      const file = path.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
      if (!file.startsWith(`${root}${path.sep}`)) throw new Error("Invalid asset path");
      const body = await readFile(file);
      res.writeHead(200, {
        "content-type": mime[path.extname(file)] ?? "application/octet-stream",
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("Isolated UI fixture: asset not found");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export async function fixturePage(browser, base, theme, viewport) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const status = testStatus();
  const nodes = [
    "Node slow",
    "Node fast",
    "Node timeout",
    "Node failed",
    "Long node name with 中文字符 and enough text to wrap over more than one line",
    ...Array.from({ length: 100 }, (_, i) => `Node ${i}`),
  ];
  const groups = ["PROXY", "Work", "Research", "Media", "Fallback", "Extra", "GLOBAL"];
  const proxies = Object.fromEntries(
    nodes.map((name) => [name, { name, type: "Direct", udp: true, history: [] }]),
  );
  for (const name of groups)
    proxies[name] = {
      name,
      type: name === "Fallback" ? "URLTest" : "Selector",
      udp: true,
      history: [],
      all: nodes,
      now: nodes[0],
    };
  const profiles = [testProfile("1"), testProfile("2")];
  const connections = Array.from({ length: 161 }, (_, i) => ({
    id: `connection-${i}`,
    upload: i * 123,
    download: i * 456,
    start: new Date(Date.now() - (i + 1) * 60_000).toISOString(),
    metadata: {
      network: "tcp",
      type: "HTTP",
      sourceIP: "127.0.0.1",
      sourcePort: "32123",
      destinationIP: "192.0.2.1",
      destinationPort: "443",
      host: `host-${i}.example.test`,
      processPath: "C:\\Tools\\browser.exe",
    },
    chains: ["PROXY", "Node fast"],
    rule: "DomainSuffix",
    rulePayload: "example.test",
  }));
  const fixture = {
    context,
    page,
    status,
    proxies,
    connections,
    trafficSockets: [],
    updateGate: null,
    failConfigs: false,
    errors: [],
    unexpected: [],
  };
  page.on("pageerror", (error) => fixture.errors.push(error.message));
  await page.addInitScript(
    ({ theme, bootId }) => {
      localStorage.setItem("sash.theme", theme);
      localStorage.setItem("sash.locale", "en");
      sessionStorage.setItem(
        "sash.control-token",
        JSON.stringify({
          token: "ui-fixture-token",
          daemonToken: bootId,
        }),
      );
    },
    { theme, bootId: status.daemon.bootId },
  );
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base) {
      fixture.unexpected.push(request.url());
      return route.abort();
    }
    const endpoint = url.pathname;
    if (!endpoint.startsWith("/sash/") && !endpoint.startsWith("/core/")) return route.continue();
    const reply = (json, status = 200) => route.fulfill({ status, json });
    if (endpoint === "/sash/daemon/health")
      return reply({
        token: status.daemon.bootId,
        pid: status.daemon.pid,
        startedAt: status.daemon.startedAt,
      });
    assert.equal(request.headers()["x-sash-token"], "ui-fixture-token");
    if (endpoint === "/sash/daemon/status") return reply(status);
    if (endpoint === "/sash/profiles") return reply({ activeId: null, profiles });
    if (endpoint === "/sash/profiles/1/update") {
      if (fixture.updateGate) await fixture.updateGate;
      return reply({ profile: profiles[0] });
    }
    if (endpoint === "/sash/autostart")
      return reply({
        supported: true,
        enabled: false,
        stateKnown: true,
        stale: false,
      });
    if (endpoint === "/core/api/configs")
      return fixture.failConfigs
        ? reply({ error: "Fixture snapshot unavailable" }, 502)
        : reply({ mode: "rule" });
    if (endpoint === "/core/api/proxies") return reply({ proxies });
    if (endpoint.startsWith("/core/api/proxies/") && request.method() === "PUT") {
      proxies[decodeURIComponent(endpoint.slice("/core/api/proxies/".length))].now =
        request.postDataJSON().name;
      return route.fulfill({ status: 204 });
    }
    if (endpoint.startsWith("/core/api/group/"))
      return reply(
        Object.fromEntries(
          nodes
            .filter((name) => name !== "Node failed")
            .map((name) => [name, name === "Node fast" ? 20 : name === "Node timeout" ? 0 : 300]),
        ),
      );
    if (endpoint.endsWith("/delay")) return reply({ error: "Fixture connection refused" }, 503);
    if (endpoint === "/core/api/connections")
      return reply({
        connections,
        uploadTotal: 100_000,
        downloadTotal: 200_000,
      });
    if (endpoint === "/core/api/rules")
      return reply({
        rules: Array.from({ length: 10_000 }, (_, i) => ({
          type: "DomainSuffix",
          payload: `rule-${i}.example.test`,
          proxy: "PROXY",
        })),
      });
    fixture.unexpected.push(`${request.method()} ${endpoint}`);
    return reply({ error: "Unexpected isolated fixture request" }, 500);
  });
  await page.routeWebSocket("**/*", (socket) => {
    const url = new URL(socket.url());
    if (url.host !== new URL(base).host) {
      fixture.unexpected.push(socket.url());
      return socket.close();
    }
    if (url.pathname === "/core/api/traffic") fixture.trafficSockets.push(socket);
    else if (url.pathname === "/core/api/logs") {
      socket.send(JSON.stringify({ type: "warning", payload: "Fixture warning" }));
    } else {
      fixture.unexpected.push(socket.url());
      socket.close();
    }
  });
  return fixture;
}
