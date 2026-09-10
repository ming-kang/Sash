import fs from "node:fs";
import { isPlainObject } from "./json-shape.js";
import { findExecutableOnPath, runSanitizedCommandAsync } from "./process.js";

export type Amd64Level = 1 | 2 | 3;

const V2 = ["sse3", "ssse3", "sse4_1", "sse4_2", "popcnt", "cx16", "lahf_lm"];
const V3 = ["avx", "avx2", "bmi1", "bmi2", "f16c", "fma", "lzcnt", "movbe", "xsave"];

/** Kernel-reported flags describe instructions available to applications, including AVX state. */
export function amd64LevelFromFlags(text: string): Amd64Level | undefined {
  const aliases: Record<string, string> = {
    pni: "sse3",
    lahf: "lahf_lm",
    abm: "lzcnt",
    avx1_0: "avx",
    avx2_0: "avx2",
  };
  const flags = new Set(
    text
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .map((flag) => {
        const normalized = flag.replaceAll(".", "_");
        return aliases[normalized] ?? normalized;
      }),
  );
  if (!flags.has("sse2")) return undefined;
  if (!V2.every((flag) => flags.has(flag))) return 1;
  return V3.every((flag) => flags.has(flag)) ? 3 : 2;
}

/** .NET's AVX support includes the OS register-state checks that raw CPUID cannot establish. */
export function amd64LevelFromWindows(value: unknown): Amd64Level | undefined {
  if (
    !isPlainObject(value) ||
    ![value.ecx, value.ebx7, value.ecxExtended].every(
      (item) =>
        typeof item === "number" &&
        Number.isInteger(item) &&
        item >= -2147483648 &&
        item <= 2147483647,
    ) ||
    typeof value.avx !== "boolean" ||
    typeof value.avx2 !== "boolean"
  )
    return undefined;
  const flags = ["sse2"];
  for (const [register, features] of [
    [
      value.ecx as number,
      [
        [0, "sse3"],
        [9, "ssse3"],
        [13, "cx16"],
        [19, "sse4_1"],
        [20, "sse4_2"],
        [23, "popcnt"],
        [12, "fma"],
        [22, "movbe"],
        [26, "xsave"],
        [29, "f16c"],
      ],
    ],
    [
      value.ebx7 as number,
      [
        [3, "bmi1"],
        [8, "bmi2"],
      ],
    ],
    [
      value.ecxExtended as number,
      [
        [0, "lahf_lm"],
        [5, "lzcnt"],
      ],
    ],
  ] as const) {
    for (const [bit, name] of features) if (register & (1 << bit)) flags.push(name);
  }
  if (value.avx) flags.push("avx");
  if (value.avx2) flags.push("avx2");
  return amd64LevelFromFlags(flags.join(" "));
}

const WINDOWS_PROBE = `
$ErrorActionPreference = 'Stop'
if (-not [System.Runtime.Intrinsics.X86.X86Base]::IsSupported) { exit 1 }
$leaf1 = [System.Runtime.Intrinsics.X86.X86Base]::CpuId(1, 0)
$leaf7 = [System.Runtime.Intrinsics.X86.X86Base]::CpuId(7, 0)
$extended = [System.Runtime.Intrinsics.X86.X86Base]::CpuId([int]::MinValue + 1, 0)
@{ ecx=$leaf1.Item3; ebx7=$leaf7.Item2; ecxExtended=$extended.Item3;
   avx=[System.Runtime.Intrinsics.X86.Avx]::IsSupported;
   avx2=[System.Runtime.Intrinsics.X86.Avx2]::IsSupported } | ConvertTo-Json -Compress
`;

let detected: Promise<Amd64Level | undefined> | undefined;

/** Detect once per process. Missing platform facilities select a baseline artifact. */
export function detectAmd64Level(): Promise<Amd64Level | undefined> {
  detected ??= (async () => {
    if (process.arch !== "x64") return undefined;
    try {
      if (process.platform === "win32") {
        const pwsh = findExecutableOnPath("pwsh.exe");
        if (!pwsh) return undefined;
        const output = await runSanitizedCommandAsync(
          pwsh,
          ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROBE],
          { timeoutMs: 3000, maxBuffer: 4096 },
        );
        return amd64LevelFromWindows(JSON.parse(output));
      }
      if (process.platform === "linux") {
        const text = await fs.promises.readFile("/proc/cpuinfo", "utf8");
        const rows = [...text.matchAll(/^flags\s*:\s*(.*)$/gm)];
        const levels = rows.map((row) => amd64LevelFromFlags(row[1] ?? ""));
        if (!levels.length || levels.some((level) => level === undefined)) return undefined;
        return Math.min(...(levels as Amd64Level[])) as Amd64Level;
      }
      if (process.platform === "darwin") {
        const flags = await runSanitizedCommandAsync(
          "/usr/sbin/sysctl",
          ["-n", "machdep.cpu.features", "machdep.cpu.leaf7_features", "machdep.cpu.extfeatures"],
          { timeoutMs: 3000, maxBuffer: 8192 },
        );
        return amd64LevelFromFlags(flags);
      }
    } catch {
      // Capability discovery must not prevent installation of a compatible build.
    }
    return undefined;
  })();
  return detected;
}
