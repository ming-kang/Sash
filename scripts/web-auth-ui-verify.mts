import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import type { Page } from "playwright";
import { runWeb } from "../src/commands/web.js";
import type { DaemonStatus } from "../src/contracts.js";
import { createDaemonClient } from "../src/sash-client-node.js";
import { DaemonTestHarness } from "../src/testing/daemon-harness.js";
import { FakeCoreSupervisor } from "../src/testing/state.js";
import { launchUiBrowser, startMockCore, uiArtifactDirectory, UI_ENGINES } from "./ui-harness.mjs";

const output = uiArtifactDirectory("sash-web-auth-ui-");
const h = new DaemonTestHarness();
h.setup();
h.settings.mixedPort = 27890;
h.settings.daemonPort = 29193;
const violations: string[] = [];
const results: string[] = [];
const versions: Record<string, string> = {};
const credentials = [h.settings.daemonSecret, h.settings.secret];
const eventStreams = new Set<http.ServerResponse>();
const foreignResponses: number[] = [];
const supervisor = new FakeCoreSupervisor(h.layout, h.settings);
let dashboardStreams = 0;

const foreignSite = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<!doctype html><title>Another local app</title>");
});
await new Promise<void>((resolve) => foreignSite.listen(0, "127.0.0.1", resolve));
const foreignAddress = foreignSite.address();
assert.ok(foreignAddress && typeof foreignAddress === "object");
const foreignOrigin = `http://127.0.0.1:${foreignAddress.port}`;

const core = await startMockCore({
  handle: (req, res) => {
    if (req.headers.authorization !== `Bearer ${h.settings.secret}`) {
      violations.push("Core gateway did not substitute the Core credential");
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
      },
      "/proxies": { proxies: { DIRECT: { name: "DIRECT", type: "Direct", udp: true, history: [] } } },
      "/rules": { rules: [] },
      "/connections": { connections: [], uploadTotal: 0, downloadTotal: 0 },
    };
    const body = bodies[req.url ?? ""];
    if (req.method !== "GET" || body === undefined) violations.push("Unexpected mock Core request");
    res.writeHead(body === undefined ? 404 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body ?? {}));
  },
  stream: (req) => {
    if (req.headers.authorization !== `Bearer ${h.settings.secret}`) {
      violations.push("WebSocket gateway did not substitute the Core credential");
    }
    if (req.headers.origin === foreignOrigin) violations.push("A foreign page reached a Core stream");
    else dashboardStreams++;
  },
});
h.settings.controller = `127.0.0.1:${core.port}`;
await h.startServer({ supervisor });
function trackRequests(): void {
  h.instance?.server.on("request", (req, res) => {
    if (req.headers.origin === foreignOrigin) {
      res.once("finish", () => foreignResponses.push(res.statusCode));
    }
    if (req.url !== "/sash/events") return;
    eventStreams.add(res);
    res.once("close", () => eventStreams.delete(res));
  });
}
trackRequests();
assert.equal((await h.apiRequest("/sash/core/start", { method: "POST" })).statusCode, 200);
const port = h.boundPort;
assert.ok(![7890, 9090, 19090].includes(port));
const origin = `http://127.0.0.1:${port}`;

async function openFromCli(): Promise<string> {
  const opened: string[] = [];
  const messages: string[] = [];
  await runWeb(
    {},
    {
      runtimeContext: () => ({ layout: h.layout, settings: h.settings }),
      ensureDaemonSession: async () => ({
        kind: "daemon",
        daemon: { kind: "healthy", running: true, healthy: true, pid: process.pid, port },
        client: createDaemonClient(port, h.settings.daemonSecret),
      }),
      openInBrowser: (url) => {
        opened.push(url);
      },
      log: {
        info: (message) => messages.push(message),
        ok: (message) => messages.push(message),
      },
    },
  );
  assert.deepEqual(opened, [`${origin}/ui/`], "sash web opens the plain dashboard address");
  for (const credential of credentials) {
    assert.ok(
      ![...opened, ...messages].some((value) => value.includes(credential)),
      "Credential leaked into a launcher argument or CLI output",
    );
  }
  return opened[0] as string;
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
  for (const { engine, name: engineName } of UI_ENGINES) {
    const browser = await launchUiBrowser(engine);
    versions[engineName] = browser.version();
    try {
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
      ]) {
        for (const theme of ["light", "dark"]) {
          const name = `${engineName}-${viewport.width}-${theme}`;
          const context = await browser.newContext({
            viewport,
            colorScheme: theme as "light" | "dark",
            reducedMotion: "reduce",
            serviceWorkers: "block",
          });
          const pageErrors: string[] = [];
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
              if (url.origin !== origin && url.origin !== foreignOrigin) {
                violations.push("Unexpected external browser request");
                await route.abort();
              } else await route.continue();
            });
            context.on("page", (page) => {
              page.on("pageerror", (error) => pageErrors.push(error.message));
              page.on("request", (request) => {
                const headers = request.headers();
                if (headers.authorization || headers["x-sash-token"])
                  violations.push("The dashboard sent a credential of its own");
                for (const credential of credentials) {
                  if (request.url().includes(credential)) violations.push("Credential in HTTP URL");
                }
              });
            });

            const page = await context.newPage();
            page.setDefaultTimeout(10_000);
            await page.goto(`${await openFromCli()}#/overview`);
            await page.locator(".page-overview").waitFor();
            await page.locator(".settings-grid").waitFor();
            assert.equal(await page.locator(".connection-panel").count(), 0);
            for (const label of ["System Proxy", "LAN Access"]) {
              assert.equal(await page.getByRole("switch", { name: label, exact: true }).count(), 1);
            }
            assert.equal(await page.getByRole("switch", { name: "Auto Start" }).count(), 1);
            const allowed = await page.evaluate(
              async () =>
                (
                  await fetch("/sash/settings", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ systemProxy: false }),
                  })
                ).status,
            );
            assert.equal(allowed, 200, "the dashboard controls Sash without a credential");
            await capture(page, `${name}-opened`);

            const tab = await context.newPage();
            tab.setDefaultTimeout(10_000);
            await tab.goto(`${origin}/ui/#/profiles`);
            await tab.locator(".page-profiles").waitFor();
            assert.equal(await tab.locator(".connection-panel").count(), 0);
            await capture(tab, `${name}-new-tab`);
            await tab.close();

            await page.reload();
            await page.locator(".page-overview").waitFor();
            await capture(page, `${name}-reloaded`);
            assert.ok(dashboardStreams > 0, "the dashboard opened a Core stream");

            assert.ok(eventStreams.size > 0, "the dashboard subscribes to status events");
            for (const stream of eventStreams) stream.destroy();
            await page.locator(".runtime-banner.offline").waitFor();
            await page.locator(".runtime-banner.offline").waitFor({ state: "hidden" });
            await page.locator(".page-overview").waitFor();
            await capture(page, `${name}-status-recovered`);

            const foreign = await context.newPage();
            await foreign.goto(foreignOrigin);
            foreignResponses.length = 0;
            const probe = await foreign.evaluate(async (target) => {
              const stop = await fetch(`${target}/sash/core/stop`, {
                method: "POST",
                mode: "no-cors",
              }).then(
                () => "sent",
                () => "failed",
              );
              const stream = await new Promise<string>((resolve) => {
                const socket = new WebSocket(`${target.replace("http:", "ws:")}/core/api/logs`);
                socket.onopen = () => {
                  socket.close();
                  resolve("open");
                };
                socket.onerror = () => resolve("refused");
              });
              return { stop, stream };
            }, origin);
            assert.equal(probe.stream, "refused", "another local origin cannot open a Core stream");
            assert.ok(foreignResponses.length > 0, "the foreign request reached Sash");
            assert.ok(
              foreignResponses.every((status) => status === 401),
              `foreign requests are refused: ${foreignResponses.join(",")}`,
            );
            const afterProbe = (await h.apiRequest("/sash/daemon/status")).data as DaemonStatus;
            assert.equal(afterProbe.core.running, true, "another local origin cannot stop Core");
            await foreign.close();

            const refused = await context.newPage();
            refused.setDefaultTimeout(10_000);
            await refused.route("**/sash/events", (route) =>
              route.fulfill({
                status: 401,
                json: { error: { code: "unauthorized", message: "Unauthorized control request" } },
              }),
            );
            await refused.goto(`${origin}/ui/#/overview`);
            await refused
              .getByRole("heading", { name: "This page cannot control Sash", exact: true })
              .waitFor();
            assert.equal(await refused.locator(".side-nav").count(), 0);
            await capture(refused, `${name}-refused`);
            await refused.close();

            await h.instance?.close();
            for (const socket of core.sockets) socket.destroy();
            await page.getByRole("heading", { name: "Sash is not running", exact: true }).waitFor();
            await page.locator(".runtime-banner.offline").waitFor();
            await capture(page, `${name}-offline`);
            await h.startServer({ supervisor }, port);
            trackRequests();
            assert.equal((await h.apiRequest("/sash/core/start", { method: "POST" })).statusCode, 200);
            await page.locator(".page-overview").waitFor();
            await page.locator(".connection-panel").waitFor({ state: "detached" });
            await capture(page, `${name}-restarted`);

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
  await core.close();
  await new Promise<void>((resolve) => foreignSite.close(() => resolve()));
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
