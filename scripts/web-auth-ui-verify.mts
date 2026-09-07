// Run after npm run build: npx tsx scripts/web-auth-ui-verify.mts
// Real daemon authorization and browser navigation; fake Core and system proxy.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { chromium, firefox, type Page } from "playwright";
import { runWeb } from "../src/commands/web.js";
import type { CoreRuntime } from "../src/core-runtime.js";
import { SashDaemonClient } from "../src/daemon-client.js";
import { DaemonTestHarness } from "../src/daemon-test-harness.test.js";
import { writeBootstrapFile } from "../src/web-bootstrap.js";

const output = await mkdtemp(join(tmpdir(), "sash-web-auth-ui-"));
const h = new DaemonTestHarness();
h.setup();
h.settings.mixedPort = 27890;
h.settings.daemonPort = 29193;
const violations: string[] = [];
const results: string[] = [];
const versions: Record<string, string> = {};
const credentials = new Set([h.settings.daemonSecret, h.settings.secret]);
const coreSockets = new Set<Duplex>();
const supervisor: CoreRuntime = {
  backend: "direct",
  isRunning: () => true,
  ownedCoreSnapshot: () => undefined,
  ownsCore: () => false,
  status: async () => ({
    running: true,
    healthy: true,
    pid: 12346,
    startedAt: "2026-01-01T00:00:00.000Z",
    tunActive: false,
  }),
  start: async () => ({ pid: 12346 }),
  restart: async () => ({ pid: 12346 }),
  stop: async () => {},
};

h.mockCoreServer = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${h.settings.secret}` || req.headers["x-sash-token"]) {
    violations.push("Core gateway credential isolation failed");
  }
  const bodies: Record<string, unknown> = {
    "/configs": {
      port: 0,
      "socks-port": 0,
      "redir-port": 0,
      "tproxy-port": 0,
      "mixed-port": 27890,
      "allow-lan": false,
      mode: "rule",
      "log-level": "info",
      tun: { enable: false },
    },
    "/proxies": { proxies: { DIRECT: { name: "DIRECT", type: "Direct", udp: true, history: [] } } },
    "/rules": { rules: [] },
    "/connections": { connections: [], uploadTotal: 0, downloadTotal: 0 },
  };
  const body = bodies[req.url ?? ""];
  if (req.method !== "GET" || body === undefined) violations.push("Unexpected mock Core request");
  res.writeHead(body === undefined ? 404 : 200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body ?? {}));
});
h.mockCoreServer.on("upgrade", (req, socket) => {
  coreSockets.add(socket);
  socket.on("error", () => {});
  socket.on("close", () => coreSockets.delete(socket));
  if (
    req.headers.authorization !== `Bearer ${h.settings.secret}` ||
    req.headers["sec-websocket-protocol"] ||
    req.headers["x-sash-token"]
  ) {
    violations.push("WebSocket gateway credential isolation failed");
  }
  const accept = crypto
    .createHash("sha1")
    .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.on("data", () => {});
});
await new Promise<void>((resolve) => h.mockCoreServer?.listen(0, "127.0.0.1", resolve));
const coreAddress = h.mockCoreServer.address();
assert.ok(coreAddress && typeof coreAddress === "object");
h.settings.controller = `127.0.0.1:${coreAddress.port}`;
await h.startServer({ supervisor });
const port = h.boundPort;
assert.ok(![7890, 9090, 19090].includes(port));
const origin = `http://127.0.0.1:${port}`;

async function browserHandoff(): Promise<string> {
  const opened: string[] = [];
  const messages: string[] = [];
  await runWeb(
    {},
    {
      runtimeContext: () => ({ layout: h.layout, settings: h.settings }),
      resolveRuntimeOwner: async () => ({
        kind: "daemon",
        daemon: { kind: "healthy", running: true, healthy: true, pid: process.pid, port },
        client: new SashDaemonClient(port, h.settings.daemonSecret),
      }),
      openInBrowser: (url) => {
        opened.push(url);
      },
      writeBootstrap: (layout, options) => {
        credentials.add(options.token);
        return writeBootstrapFile(layout, options);
      },
      log: {
        info: (message) => messages.push(message),
        warn: (message) => messages.push(message),
        ok: (message) => messages.push(message),
      },
    },
  );
  assert.equal(opened.length, 1);
  const url = opened[0];
  assert.ok(url);
  assert.ok(url.startsWith("file:"));
  for (const credential of credentials) {
    assert.ok(
      ![url, ...messages].some((value) => value.includes(credential)),
      "Credential leaked into a launcher argument or CLI output",
    );
  }
  return url;
}

async function capture(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: join(output, `${name}.png`),
    fullPage: true,
    animations: "disabled",
  });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false, `${name}: horizontal overflow`);
  const banner = await page.locator(".runtime-banner").evaluateAll((elements) => {
    const rect = elements[0]?.getBoundingClientRect();
    return rect ? { y: rect.y, height: rect.height } : null;
  });
  const header = await page.locator(".page-head").evaluateAll((elements) => {
    const rect = elements[0]?.getBoundingClientRect();
    return rect ? { y: rect.y } : null;
  });
  if (banner && header)
    assert.ok(header.y >= banner.y + banner.height - 1, `${name}: banner overlaps header`);
  results.push(name);
}

let failure: unknown;
try {
  for (const engine of [chromium, firefox]) {
    const browser = await engine.launch({ headless: true });
    versions[engine.name()] = browser.version();
    try {
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
      ]) {
        for (const theme of ["light", "dark"]) {
          const name = `${engine.name()}-${viewport.width}-${theme}`;
          const context = await browser.newContext({
            viewport,
            colorScheme: theme as "light" | "dark",
            reducedMotion: "reduce",
            serviceWorkers: "block",
          });
          const pageErrors: string[] = [];
          let failNextStatus = false;
          try {
            await context.addInitScript(
              ({ theme }) => {
                if (location.protocol !== "http:") return;
                localStorage.setItem("sash.locale", "en");
                localStorage.setItem("sash.theme", theme);
              },
              { theme },
            );
            await context.route("**/*", async (route) => {
              const url = new URL(route.request().url());
              if (url.protocol === "file:") {
                await route.continue();
                return;
              }
              if (url.origin !== origin) {
                violations.push("Unexpected external browser request");
                await route.abort();
              } else if (url.pathname === "/sash/service") {
                // Avoid probing the host's actual SCM registration.
                await route.fulfill({
                  contentType: "application/json",
                  body: JSON.stringify({ supported: false, state: "not-installed" }),
                });
              } else if (url.pathname === "/sash/daemon/status" && failNextStatus) {
                failNextStatus = false;
                await route.fulfill({
                  status: 503,
                  contentType: "application/json",
                  body: JSON.stringify({ error: { code: "internal", message: "Fixture status unavailable" } }),
                });
              } else await route.continue();
            });
            context.on("page", (page) => {
              page.on("pageerror", (error) => pageErrors.push(error.message));
              page.on("request", (request) => {
                for (const credential of credentials) {
                  if (request.url().includes(credential)) violations.push("Credential in HTTP URL");
                }
              });
            });
            const page = await context.newPage();
            page.setDefaultTimeout(10_000);
            const healthReady = page.waitForResponse((response) => response.url().endsWith("/sash/daemon/health"));
            await page.goto(`${origin}/ui/#/settings`);
            assert.equal((await healthReady).status(), 200);
            await page.locator(".connection-panel").waitFor();
            assert.equal(await page.getByRole("switch").count(), 0);
            assert.equal(
              await page.evaluate(() => sessionStorage.getItem("sash.control-token")),
              null,
            );
            const denied = await page.evaluate(
              async () =>
                (
                  await fetch("/sash/profiles", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: "{}",
                  })
                ).status,
            );
            assert.equal(denied, 401);
            await capture(page, `${name}-unauthorized`);

            const handoff = await browserHandoff();
            await page.goto(handoff);
            await page.waitForURL(`${origin}/ui/#/`);
            await page.locator(".page-overview").waitFor();
            const session = await page.evaluate(
              () =>
                JSON.parse(sessionStorage.getItem("sash.control-token") ?? "{}") as {
                  token: string;
                },
            );
            assert.ok(session.token);
            credentials.add(session.token);
            const allowed = await page.evaluate(async () => {
              const session = JSON.parse(sessionStorage.getItem("sash.control-token") ?? "{}");
              return (
                await fetch("/sash/settings", {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json", "X-Sash-Token": session.token },
                  body: JSON.stringify({ systemProxy: false }),
                })
              ).status;
            });
            assert.equal(allowed, 200);
            await capture(page, `${name}-authorized`);

            await page.reload();
            await page.locator(".page-overview").waitFor();
            assert.equal(
              await page.evaluate(
                () => JSON.parse(sessionStorage.getItem("sash.control-token") ?? "{}").token,
              ),
              session.token,
            );
            await capture(page, `${name}-reloaded`);

            failNextStatus = true;
            await page.locator(".runtime-banner.offline").waitFor();
            assert.equal(
              await page.evaluate(() => JSON.parse(sessionStorage.getItem("sash.control-token") ?? "{}").token),
              session.token,
              "a status failure must not revoke browser authorization",
            );
            await page.locator(".runtime-banner.offline").waitFor({ state: "hidden" });
            await capture(page, `${name}-status-recovered`);

            const replay = await context.newPage();
            const replayed = replay.waitForResponse((response) => response.url().endsWith("/sash/web/session"));
            await replay.goto(handoff);
            assert.equal((await replayed).status(), 401);
            await replay.locator(".connection-panel").waitFor();
            assert.equal(await replay.evaluate(() => location.hash), "#/");
            assert.equal(
              await replay.evaluate(() => sessionStorage.getItem("sash.control-token")),
              null,
            );
            await capture(replay, `${name}-replayed`);
            await replay.close();

            await h.instance?.close();
            for (const socket of coreSockets) socket.destroy();
            await h.startServer({ supervisor }, port);
            await page.locator(".connection-panel").waitFor();
            assert.equal(
              await page.evaluate(() => sessionStorage.getItem("sash.control-token")),
              null,
            );
            await capture(page, `${name}-restarted`);
            await page.goto(await browserHandoff());
            await page.locator(".page-overview").waitFor();
            await capture(page, `${name}-reauthorized`);
            assert.deepEqual(pageErrors, [], `${name}: page errors`);
            assert.deepEqual(violations, [], `${name}: isolation`);
            console.log(`PASS ${name}`);
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await browser.close();
    }
  }
} catch (error) {
  failure = error;
} finally {
  for (const socket of coreSockets) socket.destroy();
  await h.cleanup();
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(
      {
        versions,
        passed: results.length,
        results,
        violations,
        failure:
          failure instanceof Error
            ? failure.message
            : failure === undefined
              ? null
              : String(failure),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
if (failure !== undefined) throw failure;
console.log(`PASS: ${results.length} browser checks; ${JSON.stringify(versions)}; ${output}`);
