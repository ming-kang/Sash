import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
// SemVer 2.0: numeric prerelease identifiers may not have leading zeroes.
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
if (typeof version !== "string" || !semver.test(version) || /\s/.test(version)) {
  throw new Error("package.json version must be strict SemVer (without a v prefix)");
}
const args = process.argv.slice(2);
let arch = process.arch === "arm64" ? "arm64" : "amd64";
if (args.length !== 0) {
  if (args.length !== 2 || args[0] !== "--arch" || !["amd64", "arm64"].includes(args[1])) {
    throw new Error("Usage: node scripts/build-service.mjs [--arch amd64|arm64]");
  }
  arch = args[1];
}
const output = path.join(root, ".native", `windows-${arch}`, "sash-service.exe");
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !/^(?:GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN|NPM_CONFIG_.*)$/i.test(name),
  ),
);
await mkdir(path.dirname(output), { recursive: true });
const child = spawn(
  "go",
  [
    "build",
    "-mod=readonly",
    "-trimpath",
    "-buildvcs=false",
    `-ldflags=-s -w -X main.version=${version}`,
    "-o",
    output,
    ".",
  ],
  {
    cwd: path.join(root, "service"),
    env: { ...environment, GOOS: "windows", GOARCH: arch, CGO_ENABLED: "0" },
    stdio: "inherit",
    windowsHide: true,
  },
);
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) reject(new Error(`Native build terminated by ${signal}`));
    else resolve(code ?? 1);
  });
});
if (code !== 0) process.exitCode = code;
else {
  for (const name of ["LICENSE", "LICENSE.go-winio", "LICENSE.x-sys"]) {
    const destination = path.join(path.dirname(output), name);
    await chmod(destination, 0o644).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await copyFile(path.join(root, "service", name), destination);
    await chmod(destination, 0o644);
  }
  const licenses = await Promise.all(
    ["LICENSE", "LICENSE.go-winio", "LICENSE.x-sys"].map(
      async (name) =>
        `===== ${name} =====\n${await readFile(path.join(root, "service", name), "utf8")}`,
    ),
  );
  await writeFile(path.join(path.dirname(output), "sash-service-LICENSE.txt"), licenses.join("\n"));
  await writeFile(
    path.join(path.dirname(output), "sash-service-NOTICE.txt"),
    `Sash Service ${version}\nIndependently implemented MIT-licensed helper.\n` +
      "Includes github.com/Microsoft/go-winio v0.6.2 (MIT) and golang.org/x/sys v0.47.0 (BSD-3-Clause).\n" +
      "Go runtime: BSD-3-Clause, Copyright 2009 The Go Authors; identical terms in LICENSE.x-sys.\n" +
      "See sash-service-LICENSE.txt for license terms and THIRD_PARTY_NOTICES.md in the source/npm package.\n" +
      "No Core binary is included. These executables are not claimed to be Authenticode-signed.\n",
  );
  console.log(path.relative(root, output));
}
