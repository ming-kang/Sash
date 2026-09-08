// Run after npm run build: npx tsx scripts/profile-ui-verify.mts
// Real isolated daemon/profile persistence; synthetic Core, subscriptions and OS proxy.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { chromium, firefox, type Page } from "playwright";
import YAML from "yaml";
import { parseWebBootstrapInfo } from "../src/contracts.js";
import { DaemonTestHarness } from "../src/daemon-test-harness.test.js";
import { loadProfiles } from "../src/profiles.js";
import { FakeCoreSupervisor } from "../src/test-state.test.js";
import type { ProxyItem } from "../web/src/types/index.js";

const output = await mkdtemp(join(tmpdir(), "sash-profile-ui-"));
const results: string[] = [];
const errors: string[] = [];
const h = new DaemonTestHarness();
h.setup();
h.settings.mixedPort = 27893;
h.settings.daemonPort = 29194;
const sockets = new Set<Duplex>();
const supervisor = new FakeCoreSupervisor(h.layout, h.settings);
const names = [
  "【亚洲】香港 01 · 高速专线 · 原生 IP · 支持流媒体与 AI 服务",
  "【北美洲】美国洛杉矶 03 · Hysteria2 · 倍率 1.0 · 长名称验证",
  "Singapore-" + "VeryLongUnbrokenNodeName".repeat(5),
  "日本东京 05 · Vless · 晚高峰备用节点",
  "剩余流量：58.93 GB / 60.00 GB；套餐到期：2026-10-21",
  "DIRECT",
];
const doc = { proxies: names.map((name) => ({ name, type: "direct" })), rules: ["MATCH,DIRECT"] };
const content = YAML.stringify(doc);
const proxies: Record<string, ProxyItem> = Object.fromEntries(
  names.map((name, index) => [
    name,
    {
      name,
      type: index % 2 ? "Hysteria2" : "Vless",
      udp: true,
      history: [{ time: "2026-01-01T00:00:00.000Z", delay: 159 + index * 81 }],
    },
  ]),
);
proxies["AI 服务"] = {
  name: "AI 服务",
  type: "Selector",
  udp: true,
  history: [],
  now: names[0],
  all: names,
};
proxies.GLOBAL = {
  name: "GLOBAL",
  type: "Selector",
  udp: true,
  history: [],
  now: "AI 服务",
  all: ["AI 服务", ...names],
};

h.mockCoreServer = http.createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const bodies: Record<string, unknown> = {
    "/configs": { "mixed-port": 27893, "allow-lan": false, mode: "rule" },
    "/proxies": { proxies },
    "/rules": { rules: [] },
    "/connections": { connections: [], uploadTotal: 0, downloadTotal: 0 },
    "/version": { version: "1.19.30" },
  };
  const body = pathname.endsWith("/delay") ? { delay: 128 } : bodies[pathname];
  res.writeHead(body === undefined ? 404 : 200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body ?? {}));
});
h.mockCoreServer.on("upgrade", (req, socket) => {
  sockets.add(socket);
  socket.on("error", () => {});
  socket.on("close", () => sockets.delete(socket));
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
const address = h.mockCoreServer.address();
assert.ok(address && typeof address === "object");
h.settings.controller = `127.0.0.1:${address.port}`;
await h.startServer({
  supervisor,
  fetchProfile: async () => ({
    doc,
    yamlText: content,
    name: "订阅配置",
    subInfo: { upload: 100, download: 2000, total: 60000, expire: 1792537200 },
  }),
});
assert.ok(![7890, 9090, 19090].includes(h.boundPort));
const origin = `http://127.0.0.1:${h.boundPort}`;
for (const name of ["test", "MyProxies", "本地配置"]) {
  assert.equal(
    (await h.apiRequest("/sash/profiles/import", { method: "POST", body: { name, content } }))
      .statusCode,
    200,
  );
}
assert.equal(
  (
    await h.apiRequest("/sash/profiles", {
      method: "POST",
      body: { url: "https://example.test/sub" },
    })
  ).statusCode,
  200,
);
const initialIds = loadProfiles(h.layout).profiles.map((profile) => profile.id);
assert.equal((await h.apiRequest("/sash/core/start", { method: "POST" })).statusCode, 200);

async function authorize(page: Page): Promise<void> {
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("sash.locale", "zh");
  });
  const bootstrap = parseWebBootstrapInfo(
    (await h.apiRequest("/sash/web/bootstrap", { method: "POST" })).data,
  );
  await page.goto(`${origin}/ui/#boot=${bootstrap.token}`);
  await page.locator(".node-card").first().waitFor();
  await page.locator(".runtime-banner.unauthorized").waitFor({ state: "hidden" });
}

async function profilesPage(page: Page): Promise<void> {
  await page.goto(`${origin}/ui/#/profiles`);
  await page.locator(".profile-card").first().waitFor();
  await idle(page);
  await page.evaluate(() => document.fonts.ready);
}

async function idle(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.querySelector(".profiles-grid")?.getAttribute("aria-busy") === "false",
  );
}

async function waitOrder(page: Page, ids: string[]): Promise<void> {
  await idle(page);
  await page.waitForFunction(
    (expected) =>
      JSON.stringify(
        Array.from(document.querySelectorAll(".profiles-grid > .profile-card"), (el) =>
          el.getAttribute("data-id"),
        ),
      ) === JSON.stringify(expected),
    ids,
  );
  assert.deepEqual(
    loadProfiles(h.layout).profiles.map((profile) => profile.id),
    ids,
  );
}

async function capture(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    `${name}: page overflow`,
  );
  await page.screenshot({
    path: join(output, `${name}.png`),
    fullPage: true,
    animations: "disabled",
  });
  results.push(name);
}

async function drag(page: Page, from: number, to: number, cancel = false): Promise<void> {
  const cards = page.locator(".profiles-grid > .profile-card");
  const source = await cards.nth(from).boundingBox();
  const target = await cards.nth(to).boundingBox();
  assert.ok(source && target);
  await page.mouse.move(source.x + 35, source.y + source.height - 12);
  await page.mouse.down();
  await page.locator(".profile-chosen").waitFor();
  await page.mouse.move(target.x + 30, target.y + target.height / 2, { steps: 20 });
  await page.waitForTimeout(250);
  if (cancel) await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.locator(".profile-drag-ghost").waitFor({ state: "detached" });
  await idle(page);
}

try {
  for (const engine of process.argv.includes("--touch-only") ? [] : [chromium, firefox]) {
    const browser = await engine.launch();
    const tag = engine.name();
    try {
      await h.apiRequest("/sash/profiles/order", { method: "PUT", body: { ids: initialIds } });
      await h.apiRequest("/sash/profiles/active", { method: "PUT", body: { id: initialIds[3] } });
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await authorize(page);
      for (const width of [1956, 1440, 820, 390]) {
        await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
        for (const theme of ["light", "dark"]) {
          await page.evaluate((value) => {
            document.documentElement.dataset.theme = value;
          }, theme);
          const geometry = await page.locator(".node-card").evaluateAll((cards) =>
            cards.map((card) => {
              const name = card.querySelector<HTMLElement>(".node-name");
              const delay = card.querySelector<HTMLElement>(".node-delay");
              if (!name || !delay) throw new Error("Missing node fields");
              return {
                fits: name.scrollWidth <= name.clientWidth + 1,
                overlap:
                  name.getBoundingClientRect().bottom > delay.getBoundingClientRect().top + 1,
                cardFits: card.scrollWidth <= card.clientWidth + 1,
              };
            }),
          );
          assert.ok(
            geometry.length > 0 &&
              geometry.every((item) => item.fits && item.cardFits && !item.overlap),
            `${tag}/${width}/${theme}: clipped name or overlapping delay`,
          );
          await capture(page, `${tag}-nodes-${width}-${theme}`);
        }
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => {
        document.documentElement.dataset.theme = "light";
      });
      await profilesPage(page);
      // Click the card's blank bottom padding, outside its text content.
      const first = page.locator(`.profile-card[data-id="${initialIds[0]}"]`);
      const box = await first.boundingBox();
      assert.ok(box);
      await first.click({ position: { x: box.width / 2, y: box.height - 5 } });
      await idle(page);
      await page.waitForFunction(
        (id) => document.querySelector(".profile-card.active")?.getAttribute("data-id") === id,
        initialIds[0],
      );
      results.push(`${tag}: blank card area activates`);

      const remote = page.locator(`.profile-card[data-id="${initialIds[3]}"]`);
      const dialog = page.locator('[role="dialog"], [role="alertdialog"]');
      for (const action of [0, 1, 3]) {
        await remote.locator(".profile-actions button").nth(action).click();
        await dialog.waitFor();
        assert.equal(loadProfiles(h.layout).activeId, initialIds[0]);
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached" });
      }
      await remote.locator(".profile-actions button").nth(2).click();
      await idle(page);
      assert.equal(loadProfiles(h.layout).activeId, initialIds[0]);
      results.push(`${tag}: card actions do not activate`);

      const beforeStarts = supervisor.starts;
      const ordered = [initialIds[3], ...initialIds.slice(0, 3)];
      await drag(page, 3, 0);
      await waitOrder(page, ordered);
      assert.equal(loadProfiles(h.layout).activeId, initialIds[0]);
      assert.equal(supervisor.starts, beforeStarts, "Reordering must not restart Core");
      await page.reload();
      await waitOrder(page, ordered);
      results.push(`${tag}: drag persists across reload without activation or Core restart`);

      await drag(page, 3, 0, true);
      await waitOrder(page, ordered);
      results.push(`${tag}: Escape cancels drag`);

      const keyboardId = ordered[0];
      await page
        .locator(`.profile-card[data-id="${keyboardId}"] .profile-card-main`)
        .press("Alt+ArrowDown");
      const keyboardOrder = [ordered[1], ordered[0], ...ordered.slice(2)];
      await waitOrder(page, keyboardOrder);
      assert.equal(await page.locator(":focus").getAttribute("class"), "profile-card-main");
      results.push(`${tag}: keyboard reorders and retains focus`);

      await page.route("**/sash/profiles/order", (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Simulated order save failure" }),
        }),
      );
      const failedSave = page.waitForResponse(
        (response) =>
          response.url().endsWith("/sash/profiles/order") && response.request().method() === "PUT",
      );
      await drag(page, 3, 0);
      assert.equal((await failedSave).status(), 500);
      await waitOrder(page, keyboardOrder);
      assert.equal(loadProfiles(h.layout).activeId, initialIds[0]);
      await page.unroute("**/sash/profiles/order");
      results.push(`${tag}: failed save restores committed order`);

      const held = page.locator(`.profile-card[data-id="${initialIds[2]}"]`);
      const heldBox = await held.boundingBox();
      assert.ok(heldBox);
      await page.mouse.move(heldBox.x + 35, heldBox.y + heldBox.height - 12);
      await page.mouse.down();
      await page.locator(".profile-chosen").waitFor();
      await page.mouse.up();
      await idle(page);
      assert.equal(loadProfiles(h.layout).activeId, initialIds[0]);
      await held.locator(".profile-card-main").click();
      await idle(page);
      assert.equal(loadProfiles(h.layout).activeId, initialIds[2]);
      results.push(`${tag}: holding without moving does not activate; next click works`);

      await page.mouse.move(heldBox.x + 35, heldBox.y + heldBox.height - 12);
      await page.mouse.down();
      await page.locator(".profile-chosen").waitFor();
      await page.mouse.move(heldBox.x + 45, heldBox.y + 25, { steps: 5 });
      await page.locator(".profile-drag-ghost").waitFor();
      await page.evaluate(() => {
        window.location.hash = "/settings";
      });
      await page.locator(".profile-drag-ghost").waitFor({ state: "detached" });
      await page.mouse.up();
      await profilesPage(page);
      await waitOrder(page, keyboardOrder);
      results.push(`${tag}: navigation cancels drag and removes the ghost`);

      for (const width of [1956, 1440, 820, 390]) {
        await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
        for (const theme of ["light", "dark"]) {
          await page.evaluate((value) => {
            document.documentElement.dataset.theme = value;
          }, theme);
          await capture(page, `${tag}-profiles-${width}-${theme}`);
        }
      }
      await page.close();
    } catch (error) {
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          await page
            .screenshot({ path: join(output, `${tag}-failure.png`), fullPage: true })
            .catch(() => {});
          console.error(
            JSON.stringify({
              expectedDiskOrder: loadProfiles(h.layout).profiles.map((profile) => profile.id),
              dom: await page
                .locator(".profiles-grid > .profile-card")
                .evaluateAll((elements) =>
                  elements.map((element) => ({
                    id: element.getAttribute("data-id"),
                    className: element.className,
                  })),
                ),
            }),
          );
        }
      }
      throw error;
    } finally {
      await browser.close();
    }
  }

  // Drive actual touch events in Chromium; quick vertical gestures must remain scrollable.
  const browser = await chromium.launch();
  try {
    await h.apiRequest("/sash/profiles/order", { method: "PUT", body: { ids: initialIds } });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    await authorize(page);
    await profilesPage(page);
    await waitOrder(page, initialIds);
    await page.evaluate(() => {
      const events: string[] = [];
      Reflect.set(window, "profileDragEvents", events);
      for (const type of [
        "pointerdown",
        "pointercancel",
        "pointerup",
        "touchcancel",
        "choose",
        "start",
        "unchoose",
        "end",
      ]) {
        document.addEventListener(type, () => {
          events.push(type);
        });
      }
    });
    const active = loadProfiles(h.layout).activeId;
    const cards = page.locator(".profiles-grid > .profile-card");
    const source = await cards.nth(2).boundingBox();
    const target = await cards.nth(0).boundingBox();
    assert.ok(source && target);
    const session = await context.newCDPSession(page);
    const start = { x: source.x + 35, y: source.y + source.height - 12 };
    const end = { x: target.x + 35, y: target.y + target.height / 4 };
    assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".profile-card")?.getAttribute("data-id"), start), initialIds[2]);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
    await page.locator(".profile-chosen").waitFor();
    for (let step = 1; step <= 15; step += 1) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          {
            x: start.x + ((end.x - start.x) * step) / 15,
            y: start.y + ((end.y - start.y) * step) / 15,
          },
        ],
      });
      await page.waitForTimeout(20);
    }
    await page.waitForTimeout(200);
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await waitOrder(page, [initialIds[2], initialIds[0], initialIds[1], initialIds[3]]);
    assert.equal(loadProfiles(h.layout).activeId, active);
    results.push("chromium: touch long press reorders without activating");
    await capture(page, "chromium-profiles-touch");

    for (let index = 0; index < 5; index += 1) {
      assert.equal(
        (
          await h.apiRequest("/sash/profiles/import", {
            method: "POST",
            body: { name: `滚动验证 ${index + 1}`, content },
          })
        ).statusCode,
        200,
      );
    }
    await page.reload();
    await idle(page);
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
    const beforeScroll = loadProfiles(h.layout);
    const scrollCard = await cards.nth(2).boundingBox();
    assert.ok(scrollCard);
    const scrollStart = { x: scrollCard.x + 50, y: scrollCard.y + scrollCard.height / 2 };
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [scrollStart],
    });
    for (let step = 1; step <= 10; step += 1) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: scrollStart.x, y: scrollStart.y - step * 22 }],
      });
      await page.waitForTimeout(15);
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForFunction(() => scrollY > 40);
    assert.deepEqual(loadProfiles(h.layout), beforeScroll);
    assert.equal(await page.locator(".profile-drag-ghost").count(), 0);
    results.push("chromium: quick touch swipe scrolls without reordering or activating");
  } catch (error) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        await page
          .screenshot({ path: join(output, "touch-failure.png"), fullPage: true })
          .catch(() => {});
        console.error(
          JSON.stringify({
            disk: loadProfiles(h.layout).profiles.map((profile) => profile.id),
            browser: await page.evaluate(() => ({
              events: Reflect.get(window, "profileDragEvents"),
              ids: Array.from(document.querySelectorAll(".profiles-grid > .profile-card"), (el) =>
                el.getAttribute("data-id"),
              ),
              scrollY,
            })),
          }),
        );
      }
    }
    throw error;
  } finally {
    await browser.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ output, checks: results.length, results }, null, 2));
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify({ results, errors }, null, 2));
  for (const socket of sockets) socket.destroy();
  // The harness owns only the fresh directory created by setup and its in-process servers.
  assert.ok(h.layout.root.startsWith(join(tmpdir(), "sash-daemon-test-")));
  await h.cleanup();
  console.log(`Artifacts: ${output}`);
}
