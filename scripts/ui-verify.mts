/** Real dashboard, HTTP/auth and Core controls with isolated files and fake Core/OS adapters. */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { chromium, firefox, type BrowserType, type Page } from "playwright";
import { parseDaemonStatus, parseProfileActionResponse, parseWebBootstrapInfo } from "../src/contracts.js";
import { DaemonTestHarness } from "../src/daemon-test-harness.test.js";
import { FakeCoreSupervisor } from "../src/test-state.test.js";

const outDir = path.resolve(process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), "sash-ui-verify-")));
fs.mkdirSync(outDir, { recursive: true });
const yaml = "proxies:\n  - name: node-a\n    type: direct\nrules: ['MATCH,DIRECT']\n";

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const prefix = Buffer.alloc(body.length < 126 ? 2 : 4);
  prefix[0] = 0x81;
  prefix[1] = body.length < 126 ? body.length : 126;
  if (body.length >= 126) prefix.writeUInt16BE(body.length, 2);
  return Buffer.concat([prefix, body]);
}

async function apply(page: Page): Promise<void> {
  await page.locator(".pending-config").getByRole("button", { name: "应用配置", exact: true }).click();
  const confirmation = page.getByRole("alertdialog");
  await confirmation.getByRole("button", { name: "确认", exact: true }).click();
  await page.locator(".pending-config").waitFor({ state: "hidden" });
}

async function verify(engine: BrowserType, name: string) {
  const harness = new DaemonTestHarness(); harness.setup();
  const core = new FakeCoreSupervisor(harness.layout, harness.settings);
  const sockets = new Set<Duplex>();
  let mode = "rule";
  let coreReads = 0;
  const nodes = Object.fromEntries(Array.from({ length: 300 }, (_, i) => {
    const name = `节点 ${String(i).padStart(3, "0")} / sample`;
    return [name, { name, type: "Direct", udp: true, history: [] }];
  }));
  const group = { name: "PROXY", type: "Selector", udp: true, history: [], all: Object.keys(nodes), now: Object.keys(nodes)[0] };
  const rules = Array.from({ length: 10_000 }, (_, i) => ({ type: "DomainSuffix", payload: `sample-${i}.test`, proxy: "PROXY" }));
  const connections = Array.from({ length: 500 }, (_, i) => ({ id: String(i), metadata: { network: "tcp", type: "HTTP", sourceIP: "127.0.0.1", destinationIP: "192.0.2.1", sourcePort: "40000", destinationPort: "443", host: `sample-${i}.test`, processPath: "C:\\Tools\\sample.exe" }, upload: i * 100, download: i * 200, start: "2026-09-08T00:00:00.000Z", chains: ["PROXY"], rule: "DomainSuffix", rulePayload: "sample.test" }));
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${harness.settings.secret}`) { res.writeHead(401); res.end(); return; }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "PATCH" && url.pathname === "/configs") {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      mode = (JSON.parse(Buffer.concat(chunks).toString()) as { mode: string }).mode;
      res.writeHead(204); res.end(); return;
    }
    if (req.method === "DELETE") { res.writeHead(204); res.end(); return; }
    if (["/configs", "/proxies", "/rules", "/connections"].includes(url.pathname)) coreReads += 1;
    const body = url.pathname === "/version" ? { version: "v1.0.0" }
      : url.pathname === "/configs" ? { mode }
      : url.pathname === "/proxies" ? { proxies: { ...nodes, PROXY: group } }
      : url.pathname === "/rules" ? { rules }
      : url.pathname === "/connections" ? { connections, uploadTotal: 125_000, downloadTotal: 500_000 }
      : url.pathname.endsWith("/delay") ? { delay: 12 } : {};
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(body));
  });
  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    const accept = crypto.createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const timer = setInterval(() => {
      if (!socket.destroyed) socket.write(frame(req.url?.startsWith("/logs") ? { type: "info", payload: "界面验证 / isolated sample" } : { up: 1000, down: 2000 }));
    }, 200);
    socket.on("data", (data: Buffer) => { if ((data[0] ?? 0) % 16 === 8) socket.end(Buffer.from([0x88, 0])); });
    socket.once("close", () => { clearInterval(timer); sockets.delete(socket); });
    socket.on("error", () => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  harness.settings.controller = `127.0.0.1:${address.port}`;
  harness.mockCoreServer = server;
  await harness.startServer({ supervisor: core });
  const first = parseProfileActionResponse((await harness.apiRequest("/sash/profiles/import", { method: "POST", body: { name: "工作配置", content: yaml } })).data).profile;
  const second = parseProfileActionResponse((await harness.apiRequest("/sash/profiles/import", { method: "POST", body: { name: "备用配置", content: yaml.replace("node-a", "node-b") } })).data).profile;
  assert.equal((await harness.apiRequest("/sash/core/start", { method: "POST" })).statusCode, 200);
  const base = `http://127.0.0.1:${harness.boundPort}/ui/`;
  const browser = await engine.launch({ headless: true });
  const errors: string[] = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  try {
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    await page.getByRole("heading", { name: "连接到 Sash", exact: true }).waitFor();
    const boot = parseWebBootstrapInfo((await harness.apiRequest("/sash/web/bootstrap", { method: "POST" })).data);
    await page.goto(`${base}#boot=${boot.token}`);
    await page.getByText("工作配置", { exact: true }).waitFor();
    await page.locator(".runtime-banner.unauthorized").waitFor({ state: "hidden" });
    await page.evaluate(() => document.fonts.ready);
    const fonts = await page.evaluate(() => ({ family: getComputedStyle(document.body).fontFamily, loaded: [...document.fonts].filter((font) => font.family.includes("LXGW") && font.status === "loaded").length }));
    assert.match(fonts.family, /LXGW WenKai Lite/); assert.ok(fonts.loaded > 0);
    await page.screenshot({ path: path.join(outDir, `${name}-overview-light.png`) });
    await page.reload(); await page.getByText("工作配置", { exact: true }).waitFor();

    await page.goto(`${base}#/profiles`);
    await page.getByRole("button", { name: "改名: 工作配置", exact: true }).waitFor();
    await page.waitForTimeout(200); const beforeReads = coreReads;
    await page.getByRole("button", { name: "改名: 工作配置", exact: true }).click();
    await page.getByRole("dialog").getByRole("textbox").fill("工作配置 新");
    await page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
    await page.getByText("工作配置 新", { exact: true }).waitFor();
    await page.waitForTimeout(500); assert.equal(coreReads, beforeReads, "metadata rename fetched off-screen Core tables");
    await page.locator(".profile-card").filter({ has: page.getByText("备用配置", { exact: true }) }).locator(".profile-card-main").click();
    await page.locator(".pending-config").waitFor();
    assert.equal(parseDaemonStatus((await harness.apiRequest("/sash/daemon/status")).data).configuration.appliedProfile?.id, first.id);
    await apply(page);
    assert.equal(parseDaemonStatus((await harness.apiRequest("/sash/daemon/status")).data).configuration.appliedProfile?.id, second.id);
    await page.getByRole("button", { name: "编辑: 备用配置", exact: true }).click();
    await page.locator(".cm-editor").waitFor(); await page.screenshot({ path: path.join(outDir, `${name}-profile-editor.png`) });
    await page.keyboard.press("Escape"); await page.getByRole("dialog").waitFor({ state: "hidden" });

    await page.goto(`${base}#/settings`); await page.locator("#mixed-port").waitFor();
    const starts = core.starts; await page.locator("#mixed-port").fill("18888");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.locator(".pending-config").waitFor(); assert.equal(core.starts, starts);
    await page.getByRole("button", { name: "深色", exact: true }).click();
    await page.screenshot({ path: path.join(outDir, `${name}-settings-pending-dark.png`) });
    await apply(page); assert.equal(core.starts, starts + 1);
    for (const route of ["overview", "profiles", "connections", "rules", "logs", "settings"]) {
      await page.goto(`${base}#/${route}`); await page.waitForTimeout(300);
      if (route === "rules") assert.ok(await page.locator("tbody tr").count() <= 80, "rules were not paginated");
      await page.screenshot({ path: path.join(outDir, `${name}-${route}-dark.png`) });
    }
    await page.getByRole("button", { name: "停止核心", exact: true }).click();
    await page.getByRole("button", { name: "启动核心", exact: true }).waitFor(); assert.equal(core.running, false);
    await page.getByRole("button", { name: "启动核心", exact: true }).click();
    await page.getByRole("button", { name: "应用配置", exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}#/overview`); await page.waitForTimeout(300);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "mobile layout overflow");
    await page.screenshot({ path: path.join(outDir, `${name}-overview-mobile.png`) });
    assert.deepEqual(errors, []);
    console.log(`${name}: auth, refresh, save/apply, stop/start, metadata requests, fonts and layouts passed`);
    return { engine: name, fonts, errors, coreReads };
  } catch (error) {
    await page.screenshot({ path: path.join(outDir, `${name}-failure.png`), fullPage: true });
    fs.writeFileSync(path.join(outDir, `${name}-failure.json`), JSON.stringify({ errors, url: page.url(), body: await page.locator("body").innerText() }, null, 2));
    throw error;
  } finally {
    await browser.close(); for (const socket of sockets) socket.destroy(); await harness.cleanup();
  }
}

const results = [];
for (const [engine, name] of [[chromium, "chromium"], [firefox, "firefox"]] as const) results.push(await verify(engine, name));
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(results, null, 2));
console.log(`UI report: ${outDir}`);
