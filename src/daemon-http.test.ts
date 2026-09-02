import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { HttpError, parseJsonObjectBody } from "./daemon-http.js";

function requestStream(): IncomingMessage {
  const stream = new PassThrough();
  Object.defineProperty(stream, "complete", { value: false, writable: true });
  return stream as unknown as IncomingMessage;
}

function isHttpError(statusCode: number, message: RegExp): (error: unknown) => boolean {
  return (error) =>
    error instanceof HttpError && error.statusCode === statusCode && message.test(error.message);
}

describe("daemon JSON request bodies", () => {
  it("rejects an aborted body without leaving the parser pending", async () => {
    const req = requestStream();
    const parsed = parseJsonObjectBody(req);
    req.emit("data", Buffer.from('{"key":'));
    req.emit("aborted");

    await assert.rejects(parsed, isHttpError(400, /aborted/));
    req.destroy();
  });

  it("rejects an oversized body with 413 while draining remaining input", async () => {
    const req = requestStream();
    const parsed = parseJsonObjectBody(req, 4);
    req.emit("data", Buffer.from("12345"));
    req.emit("end");

    await assert.rejects(parsed, isHttpError(413, /too large/));
    req.destroy();
  });
});
