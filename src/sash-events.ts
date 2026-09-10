import type { AutostartStatus } from "./autostart-contract.js";
import type { DaemonStatus } from "./contracts.js";

export interface DaemonEvent {
  schemaVersion: 1;
  /** Monotonic for this daemon's stream; reconnect always delivers a complete snapshot. */
  sequence: number;
  status: DaemonStatus;
  autostart: AutostartStatus;
}

/** Events come from this installation's own daemon; only the protocol version is checked. */
export function parseDaemonEvent(value: unknown): DaemonEvent {
  const event = value as DaemonEvent;
  if (event?.schemaVersion !== 1) throw new TypeError("Invalid daemon event");
  return event;
}

const MAX_EVENT_CHARS = 4 * 1024 * 1024;

/** Bounded incremental SSE decoding, including UTF-8 and CRLF split across chunks. */
export async function* decodeDaemonEvents(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<DaemonEvent> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let data: string[] = [];
  let size = 0;
  let eventType = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end = buffer.indexOf("\n");
    while (end !== -1) {
      const line = buffer.slice(0, end).replace(/\r$/, "");
      buffer = buffer.slice(end + 1);
      size += line.length;
      if (size > MAX_EVENT_CHARS) throw new Error("Daemon event exceeds the size limit");
      if (line === "") {
        if (eventType === "status" && data.length)
          yield parseDaemonEvent(JSON.parse(data.join("\n")));
        data = [];
        size = 0;
        eventType = "";
      } else if (line.startsWith("data:")) {
        const value = line.slice(5).replace(/^ /, "");
        data.push(value);
      } else if (line.startsWith("event:")) eventType = line.slice(6).trim();
      end = buffer.indexOf("\n");
    }
    if (buffer.length + size > MAX_EVENT_CHARS)
      throw new Error("Daemon event exceeds the size limit");
  }
  buffer += decoder.decode();
  if (buffer || data.length) throw new Error("Daemon event stream ended with an incomplete event");
}
