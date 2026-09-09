import { type AutostartStatus, parseAutostartStatus } from "./autostart-contract.js";
import { type DaemonStatus, parseDaemonStatus } from "./contracts.js";
import { isPlainObject } from "./json-shape.js";

export interface DaemonEvent {
  schemaVersion: 1;
  /** Monotonic for this daemon's stream; reconnect always delivers a complete snapshot. */
  sequence: number;
  status: DaemonStatus;
  autostart: AutostartStatus;
}

export function parseDaemonEvent(value: unknown): DaemonEvent {
  if (
    !isPlainObject(value) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.sequence) ||
    typeof value.sequence !== "number" ||
    value.sequence < 1
  )
    throw new TypeError("Invalid daemon event");
  return {
    schemaVersion: 1,
    sequence: value.sequence,
    status: parseDaemonStatus(value.status),
    autostart: parseAutostartStatus(value.autostart),
  };
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
