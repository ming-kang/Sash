import fs from "node:fs";
import path from "node:path";

/** Literal markers also work after package removal; existing path aliases require filesystem proof. */
export function commandLineContainsPath(commandLine: string, marker: string): boolean {
  const normalize = (value: string) => value.replaceAll("\\", "/").toLowerCase();
  if (normalize(commandLine).includes(normalize(marker))) return true;
  if (!path.isAbsolute(marker)) return false;
  let expected: string;
  try {
    expected = fs.realpathSync.native(marker);
  } catch {
    return false;
  }
  const basename = path.basename(marker).toLowerCase();
  for (const match of commandLine.matchAll(/(?:^|[ \t])(?:"([^"]*)"|([^\s"]+))(?=[ \t]|$)/g)) {
    const argument = match[1] ?? match[2];
    if (
      !argument ||
      !path.isAbsolute(argument) ||
      path.basename(argument).toLowerCase() !== basename
    )
      continue;
    // Never resolve a foreign UNC/mapped-drive argument while inspecting another process.
    if (
      process.platform === "win32" &&
      normalize(path.parse(argument).root) !== normalize(path.parse(marker).root)
    )
      continue;
    try {
      const actual = fs.realpathSync.native(argument);
      if (
        process.platform === "win32"
          ? normalize(actual) === normalize(expected)
          : actual === expected
      )
        return true;
    } catch {
      // Missing, malformed and unreadable arguments never establish ownership.
    }
  }
  return false;
}
