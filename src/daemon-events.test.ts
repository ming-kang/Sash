import assert from "node:assert/strict";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { request } from "undici";
import type { AutostartStatus } from "./autostart-contract.js";
import { DaemonEvents } from "./daemon/events.js";
import { SashDaemonClient } from "./daemon-client.js";
import { useDaemonTestHarness } from "./daemon-test-harness.test.js";
import { directDispatcherForLoopback } from "./http.js";
import { type DaemonEvent, decodeDaemonEvents } from "./sash-events.js";
import { deferredValue, FakeCoreSupervisor, testStatus } from "./test-state.test.js";

const harness = useDaemonTestHarness();

it("keeps runtime events flowing while one desktop inspection is pending", async (t) => {
  const pending = deferredValue<AutostartStatus>();
  let checks = 0;
  await harness.startServer({
    autostart: {
      inspect: async () => {
        checks++;
        return pending.promise;
      },
      set: async () => {
        throw new Error("unexpected write");
      },
    },
  });
  const controller = new AbortController();
  t.after(() => {
    controller.abort();
    pending.resolve({ state: "off", canEnable: true, reason: null });
  });
  const events = new SashDaemonClient(harness.boundPort, harness.settings.daemonSecret).events(
    controller.signal,
  );
  assert.equal((await events.next()).value?.autostart.state, "unknown");
  await harness.apiRequest("/sash/settings", { method: "PATCH", body: { allowLan: true } });
  let event = (await events.next()).value;
  while (event && event.status.revisions.state < 1) event = (await events.next()).value;
  assert.equal(event?.status.settings.allowLan, true);
  assert.equal(checks, 1);
  pending.resolve({ state: "on", canEnable: true, reason: null });
  event = (await events.next()).value;
  while (event && event.autostart.state !== "on") event = (await events.next()).value;
  assert.equal(event?.autostart.state, "on");
  await events.return(undefined);
});

it("shares snapshots, pushes committed revisions and accepts authenticated browser streams", async (t) => {
  const supervisor = new FakeCoreSupervisor(harness.layout, harness.settings);
  let observations = 0;
  supervisor.onStatus = () => {
    observations++;
  };
  await harness.startServer({ supervisor });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const client = new SashDaemonClient(harness.boundPort, harness.settings.daemonSecret);
  const first = client.events(controller.signal);
  const second = client.events(controller.signal);
  const snapshots = await Promise.all([first.next(), second.next()]);
  assert.equal(observations, 1, "subscribers share one status probe");
  assert.equal(snapshots[0].value?.sequence, snapshots[1].value?.sequence);
  assert.equal(snapshots[0].value?.status.revisions.state, 0);

  const changed = first.next();
  const response = await harness.apiRequest("/sash/settings", {
    method: "PATCH",
    body: { allowLan: true },
  });
  assert.equal(response.statusCode, 200);
  let update = await changed;
  while (update.value && update.value.status.revisions.state < 1) update = await first.next();
  assert.equal(update.value?.status.settings.allowLan, true);
  assert.ok((update.value?.sequence ?? 0) > (snapshots[0].value?.sequence ?? 0));
  await first.return(undefined);
  await second.return(undefined);

  const token = await harness.mintWebSession();
  const browser = await request(`http://127.0.0.1:${harness.boundPort}/sash/events`, {
    headers: { "x-sash-token": token },
    dispatcher: directDispatcherForLoopback(),
    signal: controller.signal,
  });
  assert.equal(browser.statusCode, 200);
  assert.match(String(browser.headers["content-type"]), /text\/event-stream/);
  const events = decodeDaemonEvents(browser.body);
  assert.equal((await events.next()).value?.status.revisions.state, 1);
  await events.return(undefined);
});

it("rejects missing or query credentials, foreign origins and unsupported methods", async () => {
  await harness.startServer();
  assert.equal((await harness.apiRequest("/sash/events", { token: "" })).statusCode, 401);
  assert.equal(
    (await harness.apiRequest(`/sash/events?token=${harness.settings.daemonSecret}`, { token: "" }))
      .statusCode,
    401,
  );
  assert.equal(
    (await harness.apiRequest("/sash/events", { origin: "https://example.test" })).statusCode,
    403,
  );
  assert.equal((await harness.apiRequest("/sash/events", { method: "POST" })).statusCode, 405);
});

it("observes external changes only while subscribed and suppresses unchanged idle samples", async (t) => {
  let calls = 0;
  let status = testStatus();
  const events: DaemonEvent[] = [];
  const hub = new DaemonEvents(async () => {
    calls++;
    return { status, autostart: { state: "off", canEnable: true, reason: null } };
  }, 50);
  t.after(() => hub.close());
  const stop = hub.subscribe(
    (event) => events.push(event),
    () => {},
  );
  await delay(160);
  assert.ok(calls >= 2);
  assert.equal(events.length, 1);
  status = { ...status, core: { running: false } };
  await delay(120);
  assert.equal(events.at(-1)?.status.core.running, false);
  stop();
  const stoppedAt = calls;
  await delay(120);
  assert.equal(calls, stoppedAt);
});

it("closes active streams during daemon shutdown and releases observation timers", async (t) => {
  const instance = await harness.startServer();
  const controller = new AbortController();
  t.after(() => controller.abort());
  const events = new SashDaemonClient(harness.boundPort, harness.settings.daemonSecret).events(
    controller.signal,
  );
  await events.next();
  const ending = events.next().catch(() => ({ done: true, value: undefined }));
  await instance.close();
  assert.equal((await ending).done, true);
});
