import type { IncomingMessage, ServerResponse } from "node:http";
import type { DaemonEvent } from "../sash-events.js";
import { isControlRequestAuthorized } from "./auth.js";
import type { DaemonContext } from "./context.js";
import { sendError } from "./http.js";

interface Subscriber {
  send(event: DaemonEvent): void;
  close(): void;
  sequence: number;
}

/** One observer for all clients; mutations trigger reads and idle sampling catches OS changes. */
export class DaemonEvents {
  private readonly subscribers = new Set<Subscriber>();
  private sampleTimer: ReturnType<typeof setInterval> | undefined;
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private reading = false;
  private pending = false;
  private dirty = false;
  private closed = false;
  private sequence = 0;
  private lastText = "";
  private lastEvent: DaemonEvent | undefined;

  constructor(
    private readonly read: () => Promise<Pick<DaemonEvent, "status" | "autostart">>,
    private readonly sampleMs = 5000,
  ) {}

  get size(): number {
    return this.subscribers.size;
  }

  subscribe(send: Subscriber["send"], close: Subscriber["close"]): () => void {
    if (this.closed) throw new Error("Daemon events are closed");
    const subscriber = { send, close, sequence: -1 };
    this.subscribers.add(subscriber);
    this.sampleTimer ??= setInterval(() => this.schedule(), this.sampleMs);
    this.sampleTimer.unref();
    this.schedule();
    return () => {
      this.subscribers.delete(subscriber);
      if (this.subscribers.size === 0) this.clearTimers();
    };
  }

  notify(): void {
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.closed || this.subscribers.size === 0) return;
    this.pending = true;
    if (this.reading || this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      void this.publish();
    }, 40);
    this.notifyTimer.unref();
  }

  private async publish(): Promise<void> {
    this.reading = true;
    this.pending = false;
    const dirty = this.dirty;
    this.dirty = false;
    try {
      const snapshot = await this.read();
      if (this.closed || this.subscribers.size === 0) return;
      const text = JSON.stringify(snapshot);
      if (dirty || text !== this.lastText || !this.lastEvent) {
        this.lastText = text;
        this.lastEvent = { schemaVersion: 1, sequence: ++this.sequence, ...snapshot };
      }
      for (const subscriber of this.subscribers) {
        if (subscriber.sequence === this.lastEvent.sequence) continue;
        subscriber.sequence = this.lastEvent.sequence;
        try {
          subscriber.send(this.lastEvent);
        } catch {
          subscriber.close();
        }
      }
    } catch {
      // Clients reconnect and obtain a fresh complete snapshot after an observation fails.
      for (const subscriber of this.subscribers) subscriber.close();
    } finally {
      this.reading = false;
      if (this.pending) this.schedule();
    }
  }

  private clearTimers(): void {
    clearInterval(this.sampleTimer);
    clearTimeout(this.notifyTimer);
    this.sampleTimer = undefined;
    this.notifyTimer = undefined;
    this.lastText = "";
    this.lastEvent = undefined;
  }

  close(): void {
    this.closed = true;
    this.clearTimers();
    for (const subscriber of this.subscribers) subscriber.close();
    this.subscribers.clear();
  }
}

/** Credentials stay in headers. Slow clients retain at most the newest pending snapshot. */
export function streamDaemonEvents(
  ctx: DaemonContext,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  if (ctx.gate.isClosing || ctx.events.size >= 64) {
    sendError(res, 503, "shutting_down", "Daemon event stream is unavailable; reconnect shortly");
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  let blocked = false;
  let pending: string | undefined;
  let disposed = false;
  const authorized = () =>
    isControlRequestAuthorized(req, {
      daemonSecret: ctx.settings.committed().daemonSecret,
      isSessionToken: (token) => ctx.webAuth.isSession(token),
    });
  const send = (text: string): void => {
    if (disposed) return;
    if (!authorized()) {
      res.destroy();
      return;
    }
    if (blocked) {
      pending = text;
      return;
    }
    blocked = !res.write(text);
  };
  const onDrain = (): void => {
    blocked = false;
    const next = pending;
    pending = undefined;
    if (next) send(next);
  };
  res.on("drain", onDrain);
  const unsubscribe = ctx.events.subscribe(
    (event) =>
      send(
        `id: ${event.status.daemon.bootId}:${event.sequence}\nevent: status\ndata: ${JSON.stringify(event)}\n\n`,
      ),
    () => res.destroy(),
  );
  const heartbeat = setInterval(() => {
    if (!authorized()) res.destroy();
    else if (!blocked) send(": heartbeat\n\n");
  }, 10_000);
  heartbeat.unref();
  res.once("close", () => {
    disposed = true;
    pending = undefined;
    clearInterval(heartbeat);
    res.off("drain", onDrain);
    unsubscribe();
  });
}
