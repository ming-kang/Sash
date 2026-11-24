import { type CommandRunner, parseWindowsConnectionLine, runReg } from "./windows-snapshot.js";

const CONNECTIONS_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Connections";
const DEFAULT_RECORDS = new Set(["defaultconnectionsettings", "savedlegacysettings"]);

export type ProxyConnectionsObservation =
  | { supported: false }
  | { supported: true; additionalRecords: number };

export function countWindowsProxyConnections(output: string): number {
  const lines = output.split(/\r?\n/).filter((line) => line.trim());
  const header = lines.shift()?.trim().toLowerCase();
  if (header !== CONNECTIONS_KEY.replace("HKCU", "HKEY_CURRENT_USER").toLowerCase())
    throw new Error("Cannot identify the Windows proxy Connections registry key");
  const names = new Set<string>();
  let count = 0;
  for (const line of lines) {
    const entry = parseWindowsConnectionLine(line);
    if (entry === null) throw new Error("Cannot parse Windows proxy connection records");
    const name = entry.name.toLowerCase();
    if (names.has(name) || names.size >= 4096)
      throw new Error("Cannot parse Windows proxy connection records");
    names.add(name);
    if (DEFAULT_RECORDS.has(name) && entry.type !== "REG_BINARY")
      throw new Error("Windows default proxy connection record has an unexpected type");
    if (entry.type !== "REG_BINARY") continue;
    if (!/^(?:[a-f0-9]{2})*$/i.test(entry.data))
      throw new Error("Windows proxy connection record has invalid binary data");
    if (!DEFAULT_RECORDS.has(name)) count += 1;
  }
  return count;
}

export async function inspectWindowsProxyConnections(
  options: { platform?: NodeJS.Platform; run?: CommandRunner } = {},
): Promise<ProxyConnectionsObservation> {
  if ((options.platform ?? process.platform) !== "win32") return { supported: false };
  const output = await (options.run ?? runReg)("reg.exe", ["query", CONNECTIONS_KEY]);
  return { supported: true, additionalRecords: countWindowsProxyConnections(output) };
}
