import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coreUpdateProgressPrinter } from "./cli-output.js";
import { type CoreUpdateProgress, coreUpdateProgressText } from "./core-update.js";

function progress(patch: Partial<CoreUpdateProgress> = {}): CoreUpdateProgress {
  return {
    stage: "downloading",
    startedAt: "2026-09-23T00:00:00.000Z",
    target: "v1.19.31",
    downloading: true,
    downloaded: 0,
    total: 21400000,
    ...patch,
  };
}

function capture(interactive: boolean): { chunks: string[]; run(fn: () => void): void } {
  const chunks: string[] = [];
  const stream = {
    isTTY: interactive,
    write(text: string): boolean {
      chunks.push(text);
      return true;
    },
  };
  const original = process.stderr;
  Object.defineProperty(process, "stderr", { value: stream, configurable: true });
  return {
    chunks,
    run(fn) {
      try {
        fn();
      } finally {
        Object.defineProperty(process, "stderr", { value: original, configurable: true });
      }
    },
  };
}

describe("Core update progress printer", () => {
  it("redraws one line in place on a terminal and closes it on settle", () => {
    const captureRun = capture(true);
    captureRun.run(() => {
      const printer = coreUpdateProgressPrinter();
      printer.onProgress(progress({ downloaded: 1_000_000 }));
      printer.onProgress(progress({ downloaded: 2_000_000 }));
      printer.onProgress(progress({ downloaded: 2_000_000 }));
      printer.settle();
    });
    assert.deepEqual(captureRun.chunks, [
      `\r\x1b[K[sash] ${coreUpdateProgressText(progress({ downloaded: 1_000_000 }))}`,
      `\r\x1b[K[sash] ${coreUpdateProgressText(progress({ downloaded: 2_000_000 }))}`,
      "\n",
    ]);
  });

  it("writes one line per change for pipes and files", () => {
    const captureRun = capture(false);
    captureRun.run(() => {
      const printer = coreUpdateProgressPrinter();
      printer.onProgress(progress({ downloaded: 1_000_000 }));
      printer.onProgress(progress({ downloaded: 1_000_000 }));
      printer.onProgress(progress({ stage: "installing", downloading: false, downloaded: 0 }));
      printer.settle();
    });
    assert.deepEqual(captureRun.chunks, [
      `[sash] ${coreUpdateProgressText(progress({ downloaded: 1_000_000 }))}\n`,
      `[sash] ${coreUpdateProgressText(progress({ stage: "installing", downloading: false, downloaded: 0 }))}\n`,
    ]);
  });

  it("stays silent when nothing was reported", () => {
    const captureRun = capture(true);
    captureRun.run(() => {
      coreUpdateProgressPrinter().settle();
    });
    assert.deepEqual(captureRun.chunks, []);
  });
});
