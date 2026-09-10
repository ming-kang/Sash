import type { IncomingMessage, ServerResponse } from "node:http";
import { STATUS_CODES } from "node:http";
import type { Duplex } from "node:stream";
import { type ApiErrorCode, apiErrorBody } from "./contracts.js";

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code?: ApiErrorCode,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export type JsonObject = Record<string, unknown>;

export function requiredParam(
  req: { params: Record<string, string | undefined> },
  name: string,
): string {
  const value = req.params[name];
  if (value === undefined) throw new Error(`Missing route parameter: ${name}`);
  return value;
}

export function parseJsonBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;

    function cleanup(): void {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("aborted", onAborted);
      req.removeListener("error", onError);
      req.removeListener("close", onClose);
    }

    function fail(error: HttpError, drain = false): void {
      if (settled) return;
      settled = true;
      cleanup();
      if (drain && !req.destroyed) req.resume();
      reject(error);
    }

    function onData(chunk: Buffer | string): void {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        fail(
          new HttpError(
            413,
            `Request body too large (exceeds ${Math.ceil(maxBytes / 1024 / 1024)}MB)`,
          ),
          true,
        );
        return;
      }
      chunks.push(buffer);
    }

    function onEnd(): void {
      if (settled) return;
      settled = true;
      cleanup();
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, "Invalid JSON request body"));
      }
    }

    function onAborted(): void {
      fail(new HttpError(400, "Request body was aborted"));
    }

    function onError(): void {
      fail(new HttpError(400, "Request body stream failed"));
    }

    function onClose(): void {
      if (!req.complete) onAborted();
    }

    req.on("data", onData);
    req.once("end", onEnd);
    req.once("aborted", onAborted);
    req.once("error", onError);
    req.once("close", onClose);
  });
}

export async function parseJsonObjectBody(
  req: IncomingMessage,
  maxBytes = 1024 * 1024,
): Promise<JsonObject> {
  const body = await parseJsonBody(req, maxBytes);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "JSON request body must be an object");
  }
  return body as JsonObject;
}

/** Same error envelope as HTTP responses, for socket rejects before an upgrade. */
export function sendSocketError(
  socket: Duplex,
  statusCode: number,
  code: ApiErrorCode,
  message: string,
  allow?: readonly string[],
): void {
  const body = `${JSON.stringify(apiErrorBody(code, message))}\n`;
  const headers = [
    `HTTP/1.1 ${statusCode} ${STATUS_CODES[statusCode] ?? "Error"}`,
    "Connection: close",
    ...(allow ? [`Allow: ${allow.join(", ")}`] : []),
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
  ];
  socket.end(`${headers.join("\r\n")}\r\n\r\n${body}`);
}

export function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

export function sendError(
  res: ServerResponse,
  statusCode: number,
  code: ApiErrorCode,
  message: string,
): void {
  sendJson(res, statusCode, apiErrorBody(code, message));
}
