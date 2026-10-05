import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setLocale } from "../i18n/index.js";
import {
  delayLevel,
  formatAgo,
  formatBytes,
  formatDate,
  formatDuration,
  formatSpeed,
  formatTime,
} from "./format.js";

const realNow = Date.now;
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
const iso = (ms: number): string => new Date(ms).toISOString();

beforeEach(() => {
  setLocale("en");
  Date.now = () => NOW;
});
afterEach(() => {
  Date.now = realNow;
});

describe("byte formatting", () => {
  const cases: Array<[number, string]> = [
    [0, "0 B"],
    [-1, "0 B"],
    [Number.NaN, "0 B"],
    [1, "1.0 B"],
    [1.5, "1.5 B"],
    [512, "512 B"],
    [1023, "1023 B"],
    [1024, "1.0 KB"],
    [1536, "1.5 KB"],
    [10.24 * 1024, "10.2 KB"],
    [100 * 1024, "100 KB"],
    [1024 ** 2 - 1, "1024 KB"],
    [1024 ** 2, "1.0 MB"],
    [5.5 * 1024 ** 2, "5.5 MB"],
    [999 * 1024 ** 2, "999 MB"],
    [1024 ** 3, "1.0 GB"],
    [2.25 * 1024 ** 3, "2.3 GB"],
    [1024 ** 4, "1.0 TB"],
    [1024 ** 5, "1024 TB"],
  ];
  it("formats byte counts with and without the per-second suffix", () => {
    for (const [input, expected] of cases) {
      assert.equal(formatBytes(input), expected);
      assert.equal(formatSpeed(input), expected === "0 B" ? "0 B/s" : `${expected}/s`);
    }
  });
});

describe("relative time formatting", () => {
  const durations: Array<[string | undefined, string]> = [
    [undefined, "-"],
    ["", "-"],
    ["not-a-date", "-"],
    [iso(NOW), "0s"],
    [iso(NOW - 59_000), "59s"],
    [iso(NOW - 60_000), "1m"],
    [iso(NOW - 599_000), "9m"],
    [iso(NOW - 3_600_000), "1h 0m"],
    [iso(NOW - (2 * 3600 + 30 * 60) * 1000), "2h 30m"],
    [iso(NOW - 86_400_000), "1d 0h"],
    [iso(NOW - (3 * 86_400 + 5 * 3600) * 1000), "3d 5h"],
    [iso(NOW + 60_000), "0s"],
  ];
  const ago: Array<[string, string]> = [
    ["not-a-date", "-"],
    [iso(0), "-"],
    [iso(NOW), "just now"],
    [iso(NOW - 30_000), "just now"],
    [iso(NOW + 30_000), "just now"],
    [iso(NOW - 60_000), "1 min ago"],
    [iso(NOW - 59 * 60_000), "59 min ago"],
    [iso(NOW - 60 * 60_000), "1 h ago"],
    [iso(NOW - 23 * 3_600_000), "23 h ago"],
    [iso(NOW - 24 * 3_600_000), "1 d ago"],
    [iso(NOW - 29 * 86_400_000), "29 d ago"],
    [iso(NOW - 30 * 86_400_000), "1 mo ago"],
    [iso(NOW - 364 * 86_400_000), "1 y ago"],
    [iso(NOW - 800 * 86_400_000), "2 y ago"],
  ];
  it("renders durations and relative timestamps", () => {
    for (const [input, expected] of durations) assert.equal(formatDuration(input), expected);
    for (const [input, expected] of ago) assert.equal(formatAgo(input), expected);
  });
});

describe("clock formatting", () => {
  it("pads each clock component and defaults to the current wall clock", () => {
    assert.equal(formatTime(new Date(2026, 0, 2, 3, 4, 5)), "03:04:05");
    assert.equal(formatTime(new Date(2026, 11, 31, 23, 59, 58)), "23:59:58");
    assert.match(formatTime(), /^\d{2}:\d{2}:\d{2}$/);
  });

  it("formats epoch seconds as a padded local date", () => {
    const p = (n: number) => String(n).padStart(2, "0");
    for (const sec of [0, 1_000_000_000, 1_782_475_200]) {
      const d = new Date(sec * 1000);
      assert.equal(formatDate(sec), `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
    }
  });
});

describe("delayLevel", () => {
  const cases: Array<[number, "good" | "mid" | "bad"]> = [
    [-1, "bad"],
    [0, "bad"],
    [1, "good"],
    [299, "good"],
    [300, "mid"],
    [799, "mid"],
    [800, "bad"],
    [5000, "bad"],
  ];
  it("classifies measurements by threshold", () => {
    for (const [input, expected] of cases) assert.equal(delayLevel(input), expected);
  });
});
