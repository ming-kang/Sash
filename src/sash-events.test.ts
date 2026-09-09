import assert from "node:assert/strict";
import { it } from "node:test";
import { SashApiError, SashClient } from "./sash-client.js";
import { readSashEvents } from "./sash-event-client.js";
import { decodeDaemonEvents, parseDaemonEvent } from "./sash-events.js";
import { testStatus } from "./test-state.test.js";

function frame(sequence = 1): string {
  const status = testStatus();
  status.activeProfile = { id: "1", name: "中文 profile", url: "https://example.test/" };
  return `event: status\r\ndata: ${JSON.stringify({ schemaVersion: 1, sequence, status, autostart: { state: "off", canEnable: true, reason: null } })}\r\n\r\n`;
}
async function* bytes(text: string, size = 1): AsyncGenerator<Uint8Array> {
  const encoded = new TextEncoder().encode(text);
  for (let i = 0; i < encoded.length; i += size) yield encoded.slice(i, i + size);
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}

it("decodes split UTF-8, CRLF, heartbeats and consecutive complete snapshots", async () => {
  const events = await collect(
    decodeDaemonEvents(bytes(`: heartbeat\r\n\r\n${frame()}${frame(2)}`)),
  );
  assert.deepEqual(
    events.map((event) => event.sequence),
    [1, 2],
  );
  assert.equal(events[0]?.status.activeProfile?.name, "中文 profile");
});

it("rejects malformed, incomplete and oversized event frames", async () => {
  assert.throws(() => parseDaemonEvent({ schemaVersion: 2, sequence: 1, status: testStatus() }));
  assert.throws(() => parseDaemonEvent({ schemaVersion: 1, sequence: -1, status: testStatus() }));
  await assert.rejects(collect(decodeDaemonEvents(bytes("event: status\ndata: {\n\n"))));
  await assert.rejects(collect(decodeDaemonEvents(bytes(frame().slice(0, -2)))), /incomplete/);
  await assert.rejects(
    collect(decodeDaemonEvents(bytes(`:${"x".repeat(4 * 1024 * 1024)}\n\n`, 65536))),
    /size limit/,
  );
});

it("uses private stream headers, cancels on return and rejects regressing sequence numbers", async () => {
  let signal: AbortSignal | undefined;
  const client = new SashClient({
    baseUrl: "http://127.0.0.1:28782",
    token: () => "secret",
    tokenHeader: "x-sash-token",
    eventFetchFn: async (url, init) => {
      assert.equal(url, "http://127.0.0.1:28782/sash/events");
      assert.equal(init.headers["x-sash-token"], "secret");
      assert.equal(init.headers.Accept, "text/event-stream");
      signal = init.signal;
      return {
        status: 200,
        contentType: "text/event-stream; charset=utf-8",
        body: bytes(frame() + frame(), 65536),
      };
    },
  });
  const iterator = client.events(new AbortController().signal);
  assert.equal((await iterator.next()).value?.sequence, 1);
  await iterator.return(undefined);
  assert.equal(signal?.aborted, true);
  await assert.rejects(collect(client.events(new AbortController().signal)), /sequence/);
});

it("preserves a known 401 when its error body fails and identifies the rejected credential", async () => {
  const rejected: string[] = [];
  await assert.rejects(
    collect(
      readSashEvents({
        url: "/sash/events",
        token: "obsolete",
        tokenHeader: "x-sash-token",
        signal: new AbortController().signal,
        onUnauthorized: (token) => rejected.push(token),
        fetchFn: async () => ({
          status: 401,
          contentType: "application/json",
          body: {
            async *[Symbol.asyncIterator]() {
              yield new Uint8Array();
              throw new Error("broken body");
            },
          },
        }),
      }),
    ),
    (error) => error instanceof SashApiError && error.status === 401,
  );
  assert.deepEqual(rejected, ["obsolete"]);
});
