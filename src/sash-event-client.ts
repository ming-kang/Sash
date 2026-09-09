import { parseApiErrorBody } from "./contracts.js";
import { SashApiError } from "./sash-api-error.js";
import { type DaemonEvent, decodeDaemonEvents } from "./sash-events.js";

export type SashEventFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{
  status: number;
  contentType: string;
  body: AsyncIterable<Uint8Array>;
}>;

const browserEventFetch: SashEventFetch = async (url, init) => {
  const response = await fetch(url, { ...init, redirect: "error" });
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    body: {
      async *[Symbol.asyncIterator]() {
        const reader = response.body?.getReader();
        if (!reader) return;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            yield value;
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      },
    },
  };
};

/** One stream attempt. Callers own reconnect policy and the lifetime of the subscription. */
export async function* readSashEvents(options: {
  url: string;
  token: string;
  tokenHeader: "authorization" | "x-sash-token";
  signal: AbortSignal;
  fetchFn?: SashEventFetch;
  onUnauthorized?: (token: string) => void;
}): AsyncGenerator<DaemonEvent> {
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  let timer = setTimeout(() => controller.abort(new Error("Daemon event headers timed out")), 8000);
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (options.token)
    headers[options.tokenHeader] =
      options.tokenHeader === "authorization" ? `Bearer ${options.token}` : options.token;
  try {
    const response = await (options.fetchFn ?? browserEventFetch)(options.url, { headers, signal });
    clearTimeout(timer);
    const touch = (): void => {
      clearTimeout(timer);
      timer = setTimeout(
        () => controller.abort(new Error("Daemon event stream stopped responding")),
        25_000,
      );
    };
    touch();
    if (response.status !== 200) {
      if (response.status === 401) options.onUnauthorized?.(options.token);
      let text = "";
      try {
        const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          text += decoder.decode(chunk, { stream: true });
          if (text.length >= 32_768) break;
        }
      } catch {
        /* Preserve the known HTTP status if the diagnostic body fails. */
      }
      let message = text.slice(0, 300).trim();
      let code: string | undefined;
      try {
        const error = parseApiErrorBody(JSON.parse(text));
        if (error) {
          message = error.message;
          code = error.code;
        }
      } catch {
        /* Plain HTTP diagnostics are also useful. */
      }
      throw new SashApiError(response.status, code, message || `HTTP ${response.status}`);
    }
    if (response.contentType.split(";")[0]?.trim().toLowerCase() !== "text/event-stream")
      throw new Error("Daemon did not return an event stream");
    async function* chunks(): AsyncGenerator<Uint8Array> {
      for await (const chunk of response.body) {
        touch();
        yield chunk;
      }
    }
    let previous: DaemonEvent | undefined;
    for await (const event of decodeDaemonEvents(chunks())) {
      if (
        previous &&
        (event.status.daemon.bootId !== previous.status.daemon.bootId ||
          event.sequence <= previous.sequence)
      )
        throw new Error("Daemon event identity or sequence changed within a stream");
      previous = event;
      yield event;
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
