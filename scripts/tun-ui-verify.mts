// Run: npx tsx scripts/tun-ui-verify.mts
// Requires a fresh dist/ui build and installed Playwright Chromium + Firefox.
// Only static assets reach an ephemeral loopback server; all APIs and WebSockets are mocked.
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, type Locator, type Page } from "playwright";
import {
  apiErrorBody,
  type DaemonStatus,
  parseDaemonStatus,
  parsePublicServiceStatus,
  type PublicServiceStatus,
  parseHealthInfo,
  parseProfilesIndex,
  parseSettingsPatch,
  parseSettingsWriteResult,
} from "../src/contracts.js";
import { tunPrivilegeGuidance } from "../src/tun-guidance.js";
import type {
  ConfigsResponse,
  ConnectionsResponse,
  ProxiesResponse,
  RulesResponse,
} from "../web/src/types/index.js";

const assets = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/ui");
await access(join(assets, "index.html"));
const output = await mkdtemp(join(tmpdir(), "sash-tun-ui-"));
console.log(`Screenshots and report: ${output}`);
const startedAt = "2026-01-01T00:00:00.000Z";
const scenarios: Array<{
  name: string;
  desired: boolean;
  core: DaemonStatus["core"];
  badge: string;
  service?: PublicServiceStatus;
}> = [
  {
    name: "off",
    desired: false,
    core: { running: true, healthy: true, tunActive: false },
    badge: "Off",
  },
  { name: "pending-start", desired: true, core: { running: false }, badge: "Pending start" },
  {
    name: "active",
    desired: true,
    core: { running: true, healthy: true, tunActive: true },
    badge: "Active",
  },
  {
    name: "inactive",
    desired: true,
    core: { running: true, healthy: true, tunActive: false },
    badge: "Inactive",
  },
  {
    name: "unverified",
    desired: true,
    core: { running: true, healthy: true },
    badge: "Unverified",
  },
  {
    name: "running-unhealthy",
    desired: true,
    core: { running: true, healthy: false },
    badge: "Unverified",
  },
  {
    name: "unexpected-active",
    desired: false,
    core: { running: true, healthy: true, tunActive: true },
    badge: "State mismatch",
  },
];
for (const service of [
  { supported: true, state: "not-installed" },
  { supported: true, state: "unavailable" },
  { supported: true, state: "incompatible" },
  { supported: true, state: "root-mismatch" },
  { supported: true, state: "ready", version: "0.1.0", coreVersion: "v1.19.30" },
  { supported: false, state: "not-installed" },
] satisfies PublicServiceStatus[]) {
  scenarios.push({ ...scenarios[0]!, name: `service-${service.supported ? service.state : "mac-unsupported"}`, service });
}
const violations: string[] = [];
const results: string[] = [];
const versions: Record<string, string> = {};
const mime: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};
const server = createServer((req, res) => {
  void (async () => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname.startsWith("/sash") || pathname.startsWith("/core")) {
      violations.push(`API reached static server: ${pathname}`);
      res.writeHead(500).end();
      return;
    }
    const file = resolve(
      assets,
      `.${decodeURIComponent(pathname === "/" ? "/index.html" : pathname)}`,
    );
    if (!file.startsWith(`${assets}${sep}`)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": mime[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  })().catch((error: unknown) => {
    violations.push(String(error));
    res.writeHead(500).end();
  });
});
server.on("upgrade", (_req, socket) => {
  violations.push("WebSocket reached static server");
  socket.destroy();
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert(address && typeof address !== "string");
const port = address.port;
assert(![7890, 9090, 19090].includes(port), "Must use a nondefault port");
const origin = `http://127.0.0.1:${port}`;

async function committed(control: Locator, route: string, value: boolean): Promise<void> {
  assert.equal(
    await control.getAttribute(route === "settings" ? "aria-checked" : "aria-pressed"),
    String(value),
  );
}

async function capture(page: Page, control: Locator, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  const widths = await page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  assert(
    widths.document <= widths.viewport && widths.body <= widths.viewport,
    `${name}: horizontal overflow ${JSON.stringify(widths)}`,
  );
  await page.screenshot({
    path: join(output, `${name}.png`),
    fullPage: true,
    animations: "disabled",
  });
  if (widths.viewport === 390) {
    // Full-page captures place the fixed bottom navigation mid-image. Also capture
    // the actual viewport, centered on TUN, so that artifact cannot hide its guidance.
    await control.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await page.screenshot({
      path: join(output, `${name}-viewport.png`),
      animations: "disabled",
    });
  }
}

let failure: unknown;
try {
  for (const engine of [chromium, firefox]) {
    // Missing executables fail explicitly; install only the absent engine with npx playwright install <engine>.
    const browser = await engine.launch({ headless: true });
    versions[engine.name()] = browser.version();
    try {
      for (const viewport of [
        { width: 1440, height: 1000 },
        { width: 390, height: 844 },
      ]) {
        for (const theme of ["light", "dark"] as const) {
          for (const routeName of ["settings", "overview"]) {
            for (const scenario of [
              ...scenarios,
              { ...scenarios[0]!, name: "failed-enable" },
              { ...scenarios[0]!, name: "saved-unverified" },
            ]) {
              const name = `${engine.name()}-${viewport.width}-${theme}-${routeName}-${scenario.name}`;
              const context = await browser.newContext({
                viewport,
                colorScheme: theme,
                locale: "en-US",
                reducedMotion: "reduce",
                serviceWorkers: "block",
              });
              let releasePatch: (() => void) | undefined;
              try {
                const pageErrors: string[] = [];
                const page = await context.newPage();
                page.setDefaultTimeout(10000);
                page.on("pageerror", (error) => pageErrors.push(error.message));
                await context.addInitScript(
                  ({ theme }) => {
                    localStorage.setItem("sash.locale", "en");
                    localStorage.setItem("sash.theme", theme);
                  },
                  { theme },
                );
                const status: DaemonStatus = parseDaemonStatus({
                  daemon: { pid: 12345, startedAt, port },
                  revisions: { profiles: 0 },
                  core: {
                    ...scenario.core,
                    ...(scenario.core.running ? { pid: 12346, startedAt, version: "1.19.0" } : {}),
                  },
                  systemProxy: {
                    desired: false,
                    applied: false,
                    appliedKnown: true,
                    stateKnown: true,
                    actual: { supported: true, enabled: false },
                  },
                  settings: {
                    mixedPort: 27890,
                    controller: "127.0.0.1:29091",
                    tun: scenario.desired,
                    allowLan: false,
                    daemonPort: port,
                    systemProxy: false,
                  },
                  activeProfile: null,
                });
                let unavailable = false;
                let patches = 0;
                let refreshFailures = 0;
                const patchArrived = Promise.withResolvers<void>();
                const patchGate = Promise.withResolvers<void>();
                releasePatch = () => patchGate.resolve();
                const errorMessage = `TUN did not become active. ${tunPrivilegeGuidance("activation-rolled-back", { platform: "win32", root: output })}`;
                await context.routeWebSocket("**/*", (socket) => {
                  socket.close();
                });
                await context.route("**/*", async (route) => {
                  try {
                    const request = route.request();
                    const url = new URL(request.url());
                    const key = `${request.method()} ${url.pathname}`;
                    const json = (body: unknown, code = 200) =>
                      route.fulfill({
                        status: code,
                        contentType: "application/json",
                        body: JSON.stringify(body),
                      });
                    if (url.origin !== origin) {
                      violations.push(`Blocked external request: ${request.url()}`);
                      await route.abort();
                      return;
                    }
                    switch (key) {
                      case "GET /sash/daemon/health":
                        await json(
                          parseHealthInfo({ token: "isolated-ui-fixture", pid: 12345, startedAt }),
                        );
                        return;
                      case "GET /sash/daemon/status":
                        if (unavailable) {
                          refreshFailures++;
                          await json(
                            apiErrorBody(
                              "core_unhealthy",
                              "Isolated verification: status unavailable",
                            ),
                            503,
                          );
                        } else await json(parseDaemonStatus(status));
                        return;
                      case "GET /sash/service":
                        await json(parsePublicServiceStatus(scenario.service ?? { supported: true, state: "ready", version: "0.1.0", coreVersion: "v1.19.30" }));
                        return;
                      case "GET /sash/profiles":
                        await json(parseProfilesIndex({ activeId: null, profiles: [] }));
                        return;
                      case "PATCH /sash/settings": {
                        assert.deepEqual(parseSettingsPatch(request.postDataJSON(), "request"), {
                          tun: true,
                        });
                        patches++;
                        patchArrived.resolve();
                        await patchGate.promise;
                        if (scenario.name === "failed-enable")
                          await json(apiErrorBody("tun_inactive", errorMessage), 409);
                        else {
                          assert.equal(
                            scenario.name,
                            "saved-unverified",
                            "Unexpected settings mutation",
                          );
                          status.settings.tun = true;
                          unavailable = true;
                          await json(
                            parseSettingsWriteResult({
                              restartRequired: false,
                              settings: status.settings,
                            }),
                          );
                        }
                        return;
                      }
                      case "GET /core/api/configs":
                        await json({
                          port: 0,
                          "socks-port": 0,
                          "redir-port": 0,
                          "tproxy-port": 0,
                          "mixed-port": 27890,
                          "allow-lan": false,
                          mode: "rule",
                          "log-level": "info",
                          tun: { enable: scenario.core.tunActive ?? false },
                        } satisfies ConfigsResponse & { tun: { enable: boolean } });
                        return;
                      case "GET /core/api/proxies":
                        await json({
                          proxies: {
                            DIRECT: { name: "DIRECT", type: "Direct", udp: true, history: [] },
                          },
                        } satisfies ProxiesResponse);
                        return;
                      case "GET /core/api/rules":
                        await json({ rules: [] } satisfies RulesResponse);
                        return;
                      case "GET /core/api/connections":
                        await json({
                          connections: [],
                          uploadTotal: 0,
                          downloadTotal: 0,
                        } satisfies ConnectionsResponse);
                        return;
                      default:
                        if (
                          request.method() === "GET" &&
                          (url.pathname === "/" ||
                            url.pathname.startsWith("/assets/") ||
                            url.pathname === "/favicon.ico")
                        ) {
                          await route.continue();
                          return;
                        }
                        violations.push(`Blocked unexpected request: ${key}`);
                        await route.abort();
                    }
                  } catch (error) {
                    // Route callbacks are event handlers: never leave their rejection
                    // unhandled, or Node could bypass the browser/server finally blocks.
                    violations.push(`Mock failure: ${String(error)}`);
                    await route.abort().catch(() => undefined);
                  }
                });
                await page.goto(`${origin}/#/${routeName}`);
                const control =
                  routeName === "settings"
                    ? page.getByRole("switch", { name: "TUN Mode (Virtual NIC)", exact: true })
                    : page.getByRole("button", { name: /^TUN Mode / });
                await control.waitFor({ state: "visible" });
                await page.waitForFunction(() =>
                  document.querySelector(
                    "#mixed-port:not(:disabled), .toggle-button:not(:disabled)",
                  ),
                );
                await committed(control, routeName, scenario.desired);
                assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
                const badge =
                  routeName === "settings"
                    ? page.locator(".caution-row .badge")
                    : control.locator(".toggle-state");
                if (routeName === "settings" && scenario.badge === "Off")
                  assert.equal(await badge.count(), 0);
                else {
                  await badge
                    .getByText(scenario.badge, { exact: true })
                    .or(badge.filter({ hasText: new RegExp(`^${scenario.badge}$`) }))
                    .first()
                    .waitFor({ state: "visible" });
                  assert.equal((await badge.textContent())?.trim(), scenario.badge);
                  if (scenario.badge !== "Off")
                    assert(
                      (await badge.getAttribute("title"))?.length,
                      "Badge has explanatory title",
                    );
                }
                if (routeName === "settings") {
                  const description = page.locator(".caution-row [role=status]");
                  assert(
                    (await description.textContent())?.trim(),
                    "TUN guidance is exposed as a live status",
                  );
                }
                if (scenario.service) {
                  if (routeName === "settings") {
                    const labels = { "not-installed": "Not installed", ready: "Ready", unavailable: "Unavailable", incompatible: "Incompatible", "root-mismatch": "Enrollment conflict" };
                    await page.waitForFunction(({ supported, label }) => {
                      const card = document.querySelector(".service-card");
                      return supported ? card?.textContent?.includes(label) : card === null;
                    }, { supported: scenario.service.supported, label: labels[scenario.service.state] });
                  }
                  const blocked = scenario.service.supported && scenario.service.state !== "ready";
                  if (blocked) await page.waitForFunction(() => document.querySelector('.caution-row button:disabled, .toggle-button:last-child:disabled'));
                  assert.equal(await control.isDisabled(), blocked);
                  if (routeName === "settings") {
                    assert.equal(await page.locator(".service-card").count(), scenario.service.supported ? 1 : 0);
                    if (scenario.service.state === "not-installed" && scenario.service.supported)
                      assert((await page.locator(".service-card").textContent())?.includes("sash service install"));
                  }
                }
                if (scenario.name === "failed-enable" || scenario.name === "saved-unverified") {
                  await control.click();
                  await Promise.race([
                    patchArrived.promise,
                    new Promise<never>((_, reject) => {
                      const timer = setTimeout(
                        () => reject(new Error("PATCH did not arrive")),
                        10000,
                      );
                      timer.unref();
                    }),
                  ]);
                  await committed(control, routeName, false);
                  assert(await control.isDisabled(), "Pending toggle must be disabled");
                  releasePatch();
                  const toast = page.locator(
                    scenario.name === "failed-enable" ? ".toast-error" : ".toast-info",
                  );
                  await toast.waitFor({ state: "visible" });
                  assert.equal(
                    await page.locator(".toast-host").getAttribute("aria-live"),
                    "polite",
                  );
                  assert(
                    (await toast.textContent())?.includes(
                      scenario.name === "failed-enable"
                        ? "TUN change failed. See details below."
                        : "Setting saved; runtime verification unavailable. Check status and logs before retrying.",
                    ),
                  );
                  await committed(control, routeName, scenario.name === "saved-unverified");
                  assert.equal(patches, 1);
                  if (scenario.name === "saved-unverified") {
                    assert(refreshFailures > 0);
                    assert.equal((await badge.textContent())?.trim(), "Unverified");
                  } else {
                    const feedback = page.locator(".tun-feedback[role=alert]");
                    await feedback.waitFor({ state: "visible" });
                    assert.equal(await feedback.locator("p").textContent(), errorMessage);
                    assert(!(await toast.textContent())?.includes(errorMessage));
                    assert.equal(await feedback.evaluate((el) => getComputedStyle(el).position), "static");
                    await capture(page, control, `${name}-toast`);
                    await toast.waitFor({ state: "detached" });
                    assert.equal(await feedback.locator("p").textContent(), errorMessage);
                  }
                }
                await capture(page, control, name);
                if (scenario.name === "failed-enable") {
                  const otherRoute = routeName === "settings" ? "overview" : "settings";
                  await page.evaluate((route) => { location.hash = `/${route}`; }, otherRoute);
                  const feedback = page.locator(".tun-feedback[role=alert]");
                  await feedback.waitFor({ state: "visible" });
                  assert.equal(await feedback.locator("p").textContent(), errorMessage);
                  await feedback.getByRole("button", { name: "Dismiss TUN error" }).click();
                  await feedback.waitFor({ state: "detached" });
                }
                assert.deepEqual(pageErrors, [], `${name}: pageerrors`);
                assert.deepEqual(violations, [], `${name}: network isolation`);
                results.push(name);
                console.log(`PASS ${name}`);
              } finally {
                releasePatch?.();
                await context.close();
              }
            }
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
  server.closeAllConnections();
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(
      {
        versions,
        passed: results.length,
        results,
        violations,
        failure:
          failure instanceof Error ? failure.stack : failure === undefined ? null : String(failure),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
if (failure !== undefined) throw failure;
console.log(`PASS: ${results.length} cases; engines ${JSON.stringify(versions)}; output ${output}`);
