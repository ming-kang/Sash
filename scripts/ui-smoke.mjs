/** Build first, then: node --import tsx scripts/ui-smoke.mjs [chromium|firefox]. */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, firefox } from "playwright";

const root = await mkdtemp(path.join(os.tmpdir(), "sash-ui-smoke-"));
process.env.SASH_HOME = path.join(root, "data");
process.env.LOCALAPPDATA = path.join(root, "local");
process.env.XDG_STATE_HOME = path.join(root, "state");
const { fixturePage, serveUi } = await import("./ui-fixture.mjs");
const { buildSanitizedEnv } = await import("../src/process.ts");
const server = await serveUi();
const report = [];

async function screenshot(page, name) {
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  assert.equal(overflow, false, `${name}: no horizontal page overflow`);
  await page.screenshot({ path: path.join(root, `${name}.png`) });
}

async function checkContrast(page) {
  const ratios = await page
    .locator(".btn-secondary:not(:disabled), .connection-tag")
    .evaluateAll((elements) => {
      function luminance(color) {
        const rgb = color
          .match(/[\d.]+/g)
          .slice(0, 3)
          .map(Number)
          .map((n) => {
            const value = n / 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
          });
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      }
      return elements.map((element) => {
        const style = getComputedStyle(element);
        const a = luminance(style.color);
        const b = luminance(style.backgroundColor);
        return {
          kind: element.className,
          ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
        };
      });
    });
  assert.ok(ratios.length > 0);
  for (const { kind, ratio } of ratios) assert.ok(ratio >= 4.5, `${kind}: contrast ${ratio}`);
  return Math.min(...ratios.map((item) => item.ratio));
}

async function exercise(fixture, label) {
  const { page } = fixture;
  const go = async (name) => {
    await page.getByRole("navigation").getByRole("button", { name, exact: true }).click();
    await page.locator(`.page-${name.toLowerCase()}`).waitFor();
  };
  await page.goto(`${server.base}/#/overview`);
  await page.locator(".pgroup").first().waitFor();
  assert.equal(await page.locator(".pgroup").count(), 6);
  assert.equal(await page.locator(".pgroup-toggle[aria-expanded='false']").count(), 2);
  const first = page.locator(".pgroup").first();
  const fifth = page.locator(".pgroup").nth(4);
  await fifth.locator(".pgroup-toggle").click();
  await first.locator(".pgroup-toggle").click();
  await page.reload();
  await first.locator(".pgroup-toggle[aria-expanded='false']").waitFor();
  assert.equal(await fifth.locator(".pgroup-toggle").getAttribute("aria-expanded"), "true");
  await first.locator(".pgroup-toggle").click();
  await first.getByRole("button", { name: "Test latency: PROXY", exact: true }).click();
  await first.locator(".node-delay").filter({ hasText: "20 ms" }).waitFor();
  await first.getByRole("button", { name: "Sort by latency", exact: true }).click();
  assert.equal(await first.locator(".node-name").first().textContent(), "Node fast");
  const fast = first
    .locator(".node-card")
    .filter({ has: page.getByText("Node fast", { exact: true }) });
  await fast.locator(".node-main").click();
  await fast.locator(".node-main[aria-pressed='true']").waitFor();
  await first.getByRole("button", { name: "Show/hide timed-out nodes" }).click();
  assert.equal(await first.getByText("Node timeout", { exact: true }).count(), 0);
  assert.equal(await first.getByText("Node failed", { exact: true }).count(), 1);
  await fast.locator(".node-delay").click();
  await fast.locator(".node-delay").filter({ hasText: "Failed" }).waitFor();
  await page.locator(".toast-error").filter({ hasText: "Fixture connection refused" }).waitFor();
  await screenshot(page, `${label}-overview`);
  while (await page.locator(".toast-error").count()) {
    const count = await page.locator(".toast-error").count();
    await page.locator(".toast-error .toast-close").first().click();
    await page.waitForFunction(
      (count) => document.querySelectorAll(".toast-error").length < count,
      count,
    );
  }
  await page.locator(".toast-success").waitFor({ state: "detached" });
  assert.equal(fixture.statusReads, 0, "connected WebUI receives status without polling");
  fixture.status.configuration.pending = true;
  fixture.status.revisions.state++;
  fixture.events.publish();
  await page.locator(".pending-config").waitFor();
  fixture.status.configuration.pending = false;
  fixture.status.revisions.state++;
  fixture.events.publish();
  await page.locator(".pending-config").waitFor({ state: "detached" });
  const subscriptions = fixture.events.connections;
  const reconnecting = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/sash/events",
  );
  fixture.events.disconnect();
  await reconnecting;
  await page.locator(".pgroup").first().waitFor();
  assert.ok(fixture.events.connections > subscriptions);
  assert.equal(fixture.statusReads, 0, "reconnection also resumes a complete event snapshot");

  const chart = page.locator(".traffic-chart path[stroke='var(--chart-down)']").first();
  const flat = await chart.getAttribute("d");
  const socket = fixture.trafficSockets.at(-1);
  assert.ok(socket);
  socket.send(JSON.stringify({ up: 1000, down: 5000 }));
  await page.waitForFunction(
    (flat) =>
      document
        .querySelector(".traffic-chart path[stroke='var(--chart-down)']")
        .getAttribute("d") !== flat,
    flat,
  );
  const peak = await chart.getAttribute("d");
  socket.close();
  await page.waitForFunction(
    () => document.querySelector(".traffic-row.down .traffic-number").textContent === "0",
  );
  assert.equal(await chart.getAttribute("d"), peak, "disconnect retains chart history");
  const reconnected = await new Promise((resolve, reject) => {
    const deadline = Date.now() + 4500;
    const check = () => {
      if (fixture.trafficSockets.at(-1) !== socket) resolve(fixture.trafficSockets.at(-1));
      else if (Date.now() > deadline) reject(new Error("Traffic did not reconnect"));
      else setTimeout(check, 50);
    };
    check();
  });
  reconnected.send(JSON.stringify({ up: 0, down: 0 }));
  await page.waitForFunction(
    (peak) =>
      document
        .querySelector(".traffic-chart path[stroke='var(--chart-down)']")
        .getAttribute("d") !== peak,
    peak,
  );
  assert.notEqual(await chart.getAttribute("d"), flat, "reconnect preserves the prior peak");

  await go("Connections");
  await page.locator(".connection-row").first().waitFor();
  const minimumContrast = await checkContrast(page);
  await page.getByRole("button", { name: "Sort by upload", exact: true }).click();
  await page.getByRole("button", { name: "Sort by upload: Descending", exact: true }).waitFor();
  await page.getByRole("button", { name: "Sort by upload: Descending", exact: true }).click();
  await page.getByRole("button", { name: "Sort by upload: Ascending", exact: true }).waitFor();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  assert.equal(
    await page.getByRole("button", { name: "Resume", exact: true }).getAttribute("aria-pressed"),
    "true",
  );
  fixture.connections[0].metadata.host = "updated-host.example.test";
  await page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/core/api/connections",
  );
  assert.equal(await page.getByText("updated-host.example.test", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.getByText("updated-host.example.test", { exact: true }).waitFor();
  await go("Rules");
  await page.getByRole("button", { name: "Last", exact: true }).click();
  await page.getByText("Page 125 of 125", { exact: true }).waitFor();
  await page.getByRole("spinbutton", { name: "Page number" }).fill("63");
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await page.getByText("Page 63 of 125", { exact: true }).waitFor();
  await page.getByRole("button", { name: "First", exact: true }).click();
  await page.getByText("Page 1 of 125", { exact: true }).waitFor();
  await screenshot(page, `${label}-rules`);
  await go("Connections");
  await page.getByText("updated-host.example.test", { exact: true }).waitFor();
  // Same traffic counters, different metadata: row memoization must still update.
  fixture.connections[0].metadata.host = "memo-updated.example.test";
  await page.getByText("memo-updated.example.test", { exact: true }).waitFor();
  await page.locator(".page-head").scrollIntoViewIfNeeded();
  await screenshot(page, `${label}-connections`);

  await go("Profiles");
  const gate = Promise.withResolvers();
  fixture.updateGate = gate.promise;
  await page.getByRole("button", { name: "Update: profile-1", exact: true }).click();
  await page.locator(".profile-actions button:disabled").first().waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Update: profile-2", exact: true }).isDisabled(),
    true,
  );
  gate.resolve();
  await page.locator(".toast-success").filter({ hasText: '"profile-1" updated' }).waitFor();
  await screenshot(page, `${label}-profiles`);
  fixture.failConfigs = true;
  await go("Overview");
  await page
    .locator(".snapshot-error")
    .filter({ hasText: "Fixture snapshot unavailable" })
    .waitFor();
  await screenshot(page, `${label}-snapshot-error`);
  fixture.failConfigs = false;
  await page.locator(".toast-success").waitFor({ state: "detached" });

  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of ["Profiles", "Overview", "Connections", "Rules"]) {
    await go(route);
    if (route === "Rules" || route === "Connections")
      await page.locator(".pagination-footer").scrollIntoViewIfNeeded();
    await screenshot(page, `${label}-${route.toLowerCase()}-mobile`);
  }
  await page.setViewportSize({ width: 320, height: 720 });
  await page.locator(".pagination-footer").scrollIntoViewIfNeeded();
  await page.getByRole("spinbutton", { name: "Page number" }).fill("125");
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await page.getByText("Page 125 of 125", { exact: true }).waitFor();
  await screenshot(page, `${label}-pagination-small`);
  assert.deepEqual(fixture.unexpected, []);
  assert.deepEqual(fixture.errors, []);
  return { label, minimumContrast };
}

async function exerciseChunkFailure(browser, label) {
  const fixture = await fixturePage(browser, server, "light", { width: 1280, height: 900 });
  const { page, context } = fixture;
  try {
    await page.goto(`${server.base}/#/overview`);
    await page.locator(".pgroup").first().waitFor();
    const gate = Promise.withResolvers();
    const pattern = "**/assets/ProfilesView-*.js";
    await page.route(pattern, async (route) => {
      await gate.promise;
      await route.abort();
    });
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Profiles", exact: true })
      .click();
    await page.getByText("Loading…", { exact: true }).waitFor();
    gate.resolve();
    await page.getByText("Could not load this page", { exact: true }).waitFor();
    await screenshot(page, `${label}-chunk-error`);
    await page.unroute(pattern);
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await page.locator(".profile-card").first().waitFor();
    assert.deepEqual(fixture.unexpected, []);
  } finally {
    await context.close();
  }
}

try {
  for (const [name, engine] of Object.entries({ chromium, firefox })) {
    if (process.argv[2] && process.argv[2] !== name) continue;
    const browser = await engine.launch({ env: buildSanitizedEnv() });
    try {
      for (const theme of ["light", "dark"]) {
        const fixture = await fixturePage(browser, server, theme, {
          width: 1440,
          height: 900,
        });
        try {
          report.push(await exercise(fixture, `${name}-${theme}`));
          console.log(`${name} ${theme}: interaction, contrast and responsive checks passed`);
        } finally {
          await fixture.context.close();
        }
      }
      await exerciseChunkFailure(browser, name);
      console.log(`${name}: chunk loading, failure and reload passed`);
    } finally {
      await browser.close();
    }
  }
  assert.ok(report.length > 0, "Select chromium or firefox");
} finally {
  await server.close();
  await writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log(`UI artifacts: ${root}`);
}
