import fs from "node:fs";
import type { SashLayout } from "./paths.js";
import { type ProfileMeta, profileFilePath, readProfileSource } from "./profiles.js";

type Source = ReturnType<typeof readProfileSource>;
interface Entry {
  identity: string;
  source: Source;
  bytes: number;
}

function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
}

/** Bounded per-daemon cache; file identity checks also detect unsupported out-of-band edits. */
export class ProfileSourceCache {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;

  constructor(
    private readonly layout: SashLayout,
    private readonly maxBytes = 16 * 1024 * 1024,
  ) {}

  read(profile: Pick<ProfileMeta, "id" | "revision">): Source {
    const file = profileFilePath(this.layout, profile.id, profile.revision);
    const cached = this.entries.get(file);
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile()) throw new Error(`Profile must be a regular file: ${file}`);
    const identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    if (cached?.identity === identity) {
      this.entries.delete(file);
      this.entries.set(file, cached);
      return cached.source;
    }
    if (cached) {
      this.entries.delete(file);
      this.bytes -= cached.bytes;
    }
    const source = readProfileSource(this.layout, profile);
    freeze(source);
    const bytes = Buffer.byteLength(source.yamlText);
    if (bytes <= this.maxBytes) {
      this.entries.set(file, { identity, source, bytes });
      this.bytes += bytes;
      while (this.bytes > this.maxBytes || this.entries.size > 8) {
        const oldest = this.entries.entries().next().value;
        if (!oldest) break;
        this.entries.delete(oldest[0]);
        this.bytes -= oldest[1].bytes;
      }
    }
    return source;
  }
}
