#!/usr/bin/env node
/**
 * Trace what the current Sash build does to this machine, one command at a time.
 *
 * Each step runs the real CLI against an isolated SASH_HOME and is bracketed by
 * snapshots of the filesystem, the Windows registry (read-only), the process
 * tree, TCP listeners and outbound HTTP requests. The output is a per-step diff
 * plus a Markdown report, so questions like "what does `sash start` leave
 * behind" are answered by observation rather than by reading the source.
 *
 * All outbound HTTP(S) is pointed at a local logging proxy, which records every
 * request the CLI, the daemon and the Core make (including the Core's own
 * geodata downloads). Loopback is excluded via NO_PROXY, which also keeps the
 * daemon's controller traffic out of the log. The system proxy and the login
 * startup registration are never written; the registry is only read.
 *
 * Usage:
 *   node scripts/trace-sash.mjs [--scenario full|install] [--via 127.0.0.1:7890]
 *                               [--direct] [--profile <subscription-url>]
 *                               [--seed-core <existing-data-dir>]
 *                               [--out <dir>] [--from-source] [--verbose]
 *                               [--step-timeout <seconds>] [--clean]
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAX_CAPTURE_BYTES = 256 * 1024;

/* cmdline: argument handling ------------------------------------------------ */

function parseArgs(argv) {
  const options = {
    scenario: "full",
    via: undefined,
    out: undefined,
    fromSource: false,
    verbose: false,
    stepTimeoutMs: 240_000,
    clean: false,
    direct: false,
    profile: undefined,
    seedCore: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      const value = argv[index];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--scenario") options.scenario = next();
    else if (arg === "--via") options.via = next();
    else if (arg === "--out") options.out = next();
    else if (arg === "--from-source") options.fromSource = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--clean") options.clean = true;
    else if (arg === "--direct") options.direct = true;
    else if (arg === "--profile") options.profile = next();
    else if (arg === "--seed-core") options.seedCore = next();
    else if (arg === "--step-timeout") options.stepTimeoutMs = Number(next()) * 1000;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!["full", "install"].includes(options.scenario))
    throw new Error(`Unknown scenario: ${options.scenario}`);
  if (!Number.isFinite(options.stepTimeoutMs) || options.stepTimeoutMs <= 0)
    throw new Error("--step-timeout must be a positive number of seconds");
  return options;
}

/* cmdline: platform helpers ------------------------------------------------- */

function defaultDataRoot() {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "Sash");
  }
  if (process.platform === "darwin")
    return path.join(os.homedir(), "Library", "Application Support", "Sash");
  const xdg = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(xdg, "sash");
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function parseHostPort(value, fallbackPort) {
  const trimmed = value.trim().replace(/^https?:\/\//i, "");
  const index = trimmed.lastIndexOf(":");
  if (index === -1) return { host: trimmed, port: fallbackPort };
  return { host: trimmed.slice(0, index), port: Number(trimmed.slice(index + 1)) };
}

/* observation: filesystem --------------------------------------------------- */

function walkFiles(root, map) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch {
      continue;
    }
    map.set(full, { size: stat.size, mtimeMs: stat.mtimeMs, isDirectory: stat.isDirectory() });
    if (stat.isDirectory()) walkFiles(full, map);
  }
  return map;
}

function captureFiles(roots) {
  const map = new Map();
  for (const root of roots) walkFiles(root, map);
  return map;
}

function diffFiles(before, after) {
  const created = [];
  const modified = [];
  const deleted = [];
  for (const [file, stat] of after) {
    const prior = before.get(file);
    if (!prior) created.push({ file, ...stat });
    else if (!stat.isDirectory && (prior.size !== stat.size || prior.mtimeMs !== stat.mtimeMs))
      modified.push({ file, ...stat, previousSize: prior.size });
  }
  for (const [file, stat] of before) {
    if (!after.has(file)) deleted.push({ file, ...stat });
  }
  return { created, modified, deleted };
}

/* observation: registry (read-only) ---------------------------------------- */

const REGISTRY_KEYS = [
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run",
];

function captureRegistry() {
  if (process.platform !== "win32") return undefined;
  return REGISTRY_KEYS.map((key) => {
    const result = spawnSync("reg.exe", ["query", key], { windowsHide: true, encoding: "buffer" });
    const output = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
    return { key, bytes: output.toString("base64"), text: decodeRegistry(output) };
  });
}

function decodeRegistry(buffer) {
  // reg.exe writes in the console code page; latin1 keeps every byte stable for
  // the report while ASCII values stay readable.
  return buffer.toString("latin1").replace(/\r\n/g, "\n").trim();
}

/* observation: the shared control directory ------------------------------- */

/** Only the top-level names matter: this directory is shared with a real instance. */
function captureControlEntries(directory) {
  try {
    return fs.readdirSync(directory).sort();
  } catch {
    return [];
  }
}

/* observation: the system temp directory ----------------------------------- */

/**
 * Only entries created or touched during the run matter; a developer machine
 * accumulates unrelated `sash*` entries from months of earlier runs.
 */
function captureTempEntries(excludeDir, since) {
  const temp = fs.realpathSync(os.tmpdir());
  const entries = [];
  let names;
  try {
    names = fs.readdirSync(temp);
  } catch {
    return entries;
  }
  for (const name of names) {
    if (!/^sash/i.test(name)) continue;
    const full = path.join(temp, name);
    if (excludeDir && samePath(full, excludeDir)) continue;
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs >= since) entries.push(`${name} (${new Date(stat.mtimeMs).toISOString()})`);
    } catch {
      /* vanished mid-scan */
    }
  }
  return entries.sort();
}

/* observation: processes and listeners ------------------------------------- */

function captureProcesses(pidsOfInterest) {
  if (process.platform !== "win32") {
    const result = spawnSync("ps", ["-eo", "pid,ppid,comm,args"], { encoding: "utf8" });
    return (result.stdout ?? "")
      .split("\n")
      .filter((line) => /(^|\s)(node|mihomo)(\s|$)/.test(line) && /sash|mihomo/i.test(line))
      .join("\n");
  }
  const script =
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  let rows = [];
  try {
    const parsed = JSON.parse(result.stdout ?? "[]");
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return `unavailable: ${(result.stderr ?? "").trim().slice(0, 200)}`;
  }
  const interesting = rows.filter((row) => {
    const commandLine = row.CommandLine ?? "";
    // Only Sash, its daemon and the Core are relevant; a shell that merely
    // mentions a path in this trace must not show up as a process Sash started.
    if (!/^(node|mihomo)(\.exe)?$/i.test(row.Name ?? "")) return false;
    return pidsOfInterest.includes(row.ProcessId) || /sash|mihomo/i.test(commandLine);
  });
  return interesting
    .map((row) => {
      const commandLine = (row.CommandLine ?? "").replace(/\s+/g, " ");
      const marker = pidsOfInterest.includes(row.ProcessId) ? "*" : " ";
      return `${marker} ${String(row.ProcessId).padStart(7)} <- ${
        row.ParentProcessId
      } ${row.Name} :: ${commandLine.slice(0, 220)}`;
    })
    .sort()
    .join("\n");
}

function captureListeners(pidsOfInterest) {
  const command = process.platform === "win32" ? "netstat" : "netstat";
  const args = process.platform === "win32" ? ["-ano", "-p", "tcp"] : ["-an", "-p", "tcp"];
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  const lines = (result.stdout ?? "").split("\n");
  return lines
    .filter((line) => /LISTEN/i.test(line))
    .filter((line) => {
      const pid = Number(line.trim().split(/\s+/).pop());
      return pidsOfInterest.includes(pid);
    })
    .map((line) => line.trim().replace(/\s+/g, " "))
    .sort()
    .join("\n");
}

/* observation: log file growth --------------------------------------------- */

const LOG_FILES = [
  "logs/sashd.log",
  "logs/sashd.err.log",
  "logs/mihomo.log",
  "logs/mihomo.err.log",
];

function captureLogSizes(traceHome) {
  const sizes = {};
  for (const relative of LOG_FILES) {
    try {
      sizes[relative] = fs.statSync(path.join(traceHome, relative)).size;
    } catch {
      sizes[relative] = undefined;
    }
  }
  return sizes;
}

function readLogGrowth(traceHome, before) {
  const growth = {};
  for (const relative of LOG_FILES) {
    const file = path.join(traceHome, relative);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    const offset = before[relative];
    if (offset === undefined || stat.size <= offset) continue;
    const length = Math.min(stat.size - offset, 16 * 1024);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buffer, 0, length, stat.size - length);
    } finally {
      fs.closeSync(fd);
    }
    growth[relative] = buffer.toString("utf8").trim();
  }
  return growth;
}

/* the logging proxy -------------------------------------------------------- */

function pipeBoth(clientSocket, upstreamSocket, entry, finish) {
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    finish();
    clientSocket.destroy();
    upstreamSocket.destroy();
  };
  clientSocket.on("data", (chunk) => {
    entry.upBytes += chunk.length;
  });
  upstreamSocket.on("data", (chunk) => {
    entry.downBytes += chunk.length;
  });
  clientSocket.pipe(upstreamSocket);
  upstreamSocket.pipe(clientSocket);
  clientSocket.on("close", done);
  clientSocket.on("error", done);
  upstreamSocket.on("close", done);
  upstreamSocket.on("error", done);
}

function startLoggingProxy({ upstream }) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const entry = {
      kind: "http",
      method: req.method,
      url: req.url,
      startedAt: Date.now(),
      upBytes: 0,
      downBytes: 0,
    };
    requests.push(entry);
    let target;
    try {
      target = new URL(req.url);
    } catch {
      entry.error = "unparsable request url";
      res.writeHead(400).end();
      return;
    }
    const hop = upstream ?? { host: target.hostname, port: Number(target.port) || 80 };
    const request = http.request(
      {
        host: hop.host,
        port: hop.port,
        method: req.method,
        path: upstream ? target.href : `${target.pathname}${target.search}`,
        headers: { ...req.headers, host: target.host },
      },
      (response) => {
        entry.status = response.statusCode;
        res.writeHead(response.statusCode, response.headers);
        response.on("data", (chunk) => {
          entry.downBytes += chunk.length;
        });
        response.pipe(res);
      },
    );
    request.on("error", (error) => {
      entry.error = error.message;
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.on("data", (chunk) => {
      entry.upBytes += chunk.length;
    });
    req.pipe(request);
    res.on("close", () => {
      entry.durationMs = Date.now() - entry.startedAt;
    });
  });

  server.on("connect", (req, clientSocket, head) => {
    const entry = {
      kind: "connect",
      target: req.url,
      startedAt: Date.now(),
      upBytes: 0,
      downBytes: 0,
    };
    requests.push(entry);
    const target = parseHostPort(req.url, 443);
    const finish = () => {
      entry.durationMs = Date.now() - entry.startedAt;
    };
    clientSocket.on("error", () => clientSocket.destroy());

    if (!upstream) {
      const upstreamSocket = net.connect(target.port, target.host, () => {
        entry.status = null;
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head?.length) upstreamSocket.write(head);
        pipeBoth(clientSocket, upstreamSocket, entry, finish);
      });
      upstreamSocket.on("error", (error) => {
        entry.error = error.message;
        clientSocket.destroy();
        finish();
      });
      return;
    }

    const upstreamSocket = net.connect(upstream.port, upstream.host);
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString("latin1");
      if (!buffer.includes("\r\n\r\n")) return;
      upstreamSocket.removeListener("data", onData);
      const status = Number(buffer.split(" ")[1]);
      entry.status = status;
      if (status !== 200) {
        entry.error = `upstream proxy refused: ${buffer.split("\r\n")[0]}`;
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        upstreamSocket.destroy();
        finish();
        return;
      }
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstreamSocket.write(head);
      pipeBoth(clientSocket, upstreamSocket, entry, finish);
    };
    upstreamSocket.on("connect", () => {
      upstreamSocket.write(
        `CONNECT ${target.host}:${target.port} HTTP/1.1\r\nHost: ${target.host}:${target.port}\r\n\r\n`,
      );
    });
    upstreamSocket.on("data", onData);
    upstreamSocket.on("error", (error) => {
      entry.error = error.message;
      clientSocket.destroy();
      finish();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        requests,
        port: server.address().port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/* the fixture subscription ------------------------------------------------- */

const FIXTURE_PROFILE = `# Served by scripts/trace-sash.mjs; never a real subscription.
mode: rule
log-level: info
# Managed keys: Sash strips these and writes its own values into runtime/config.yaml.
mixed-port: 1
allow-lan: true
external-controller: 127.0.0.1:1
proxies:
  - {name: TRACE-DEAD, type: socks5, server: 127.0.0.1, port: 9}
proxy-groups:
  - {name: PROXY, type: select, proxies: [DIRECT, TRACE-DEAD]}
rules:
  - GEOIP,CN,DIRECT
  - MATCH,PROXY
`;

function startFixtureSubscription() {
  const server = http.createServer((req, res) => {
    if (!req.url?.startsWith("/sub")) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "content-type": "text/yaml; charset=utf-8",
      "content-disposition": 'attachment; filename="trace-profile.yaml"',
      "subscription-userinfo": "upload=1000; download=2000; total=10000; expire=1900000000",
      "profile-update-interval": "6",
      "profile-web-page-url": "https://example.com/trace",
    });
    res.end(FIXTURE_PROFILE);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/sub`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/* step definitions --------------------------------------------------------- */

function scenarioSteps(scenario, fixtureUrl) {
  const steps = [
    { name: "version (read-only)", args: () => ["version"] },
    { name: "doctor on an empty data dir", args: () => ["doctor", "--json"] },
    { name: "start (cold: installs Core, starts sashd + Core)", args: () => ["start"] },
    { name: "status", args: () => ["status", "--json"] },
  ];
  if (scenario === "install") {
    return [
      ...steps,
      { name: "logs (Core stdout)", args: () => ["logs", "-n", "20"] },
      { name: "stop", args: () => ["stop"] },
    ];
  }
  return [
    ...steps,
    {
      name: "profile add (fixture subscription)",
      args: () => ["profile", "add", fixtureUrl, "--use", "--json"],
    },
    { name: "profile list", args: () => ["profile", "list", "--json"] },
    { name: "restart (applies the saved profile)", args: () => ["restart"] },
    { name: "status after apply", args: () => ["status", "--json"] },
    { name: "mode global (runtime only)", args: () => ["mode", "global", "--json"] },
    { name: "mode rule (runtime only)", args: () => ["mode", "rule", "--json"] },
    { name: "logs (Core stdout)", args: () => ["logs", "-n", "25"] },
    { name: "web --no-open (starts management, no browser)", args: () => ["web", "--no-open"] },
    { name: "stop", args: () => ["stop"] },
  ];
}

/* CLI execution ------------------------------------------------------------ */

function execCli(args, ctx) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(ctx.node, [...ctx.loader, ctx.cliPath, ...args], {
      cwd: repoRoot,
      env: ctx.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const capture = (stream, target) => {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        if (target === "stdout") stdout = (stdout + chunk).slice(-MAX_CAPTURE_BYTES);
        else stderr = (stderr + chunk).slice(-MAX_CAPTURE_BYTES);
        if (ctx.verbose) process.stdout.write(chunk);
      });
    };
    capture(child.stdout, "stdout");
    capture(child.stderr, "stderr");
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32")
        spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true });
      else child.kill("SIGKILL");
    }, ctx.stepTimeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({
        code: null,
        stdout,
        stderr: `${stderr}\n${error.message}`,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, durationMs: Date.now() - startedAt, timedOut });
    });
  });
}

/* report rendering --------------------------------------------------------- */

const ARTIFACT_NOTES = [
  [/^bin\/mihomo(\.exe)?$/, "Core binary, downloaded from the GitHub release asset"],
  [/^state\/install\.json$/, "Core install record: version, installedAt, assetName"],
  [/^(state\/)?sash\.json$/, "the only application state: settings + profile index"],
  [/^cache\.db$/, "Core-owned cache database written by mihomo itself"],
  [/^sash\.json\.bak$/, "recovery copy of the last committed manifest"],
  [/^state\/sash\.pid$/, "Core PID record {pid, exe, startedAt}"],
  [/^state\/sashd\.pid$/, "daemon PID record {pid, token, port, startedAt}"],
  [/^state\/sashd\.lock$/, "daemon singleton lease, held while sashd runs"],
  [/^state\/sashd-start\.lock$/, "short-lived CLI startup admission"],
  [/^state\/system-proxy\.json$/, "system-proxy journal holding the original OS values"],
  [/^state\/web-sessions\.json$/, "hashed browser sessions kept across daemon restarts"],
  [/^state\/core-update-transaction\.json$/, "Core update journal, present only mid-update"],
  [/^runtime\/config\.yaml$/, "generated Core configuration handed to mihomo with -f"],
  [/^logs\/sashd\.log$/, "daemon stdout"],
  [/^logs\/sashd\.err\.log$/, "daemon stderr"],
  [/^logs\/mihomo\.log$/, "Core stdout"],
  [/^logs\/mihomo\.err\.log$/, "Core stderr"],
  [/^profiles\/\d+\/\d+\.yaml$/, "verbatim copy of a subscription body"],
  [
    /^temp\/web-bootstrap-[^/]+\/index\.html$/,
    "one-time browser authorization page written by `sash web`",
  ],
  [/^temp\//, "staging area for downloads and config validation"],
  [/^ui\//, "reserved for dashboard assets inside the data dir"],
  [
    /^Geo(IP|Site)\.dat$|^geoip\.metadb$|^geosite\.dat$|^country\.mmdb$/,
    "geodata written by the Core, not by Sash",
  ],
  [/^\./, "temporary publication file"],
];

function annotate(relative) {
  const normalized = relative.split(path.sep).join("/");
  for (const [pattern, note] of ARTIFACT_NOTES) if (pattern.test(normalized)) return note;
  return "";
}

function formatBytes(size) {
  if (size === undefined) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / 1024 / 1024).toFixed(1)} MiB`;
}

function formatHttp(entry) {
  const duration =
    entry.durationMs === undefined ? "" : ` ${(entry.durationMs / 1000).toFixed(1)}s`;
  const size = entry.downBytes ? ` ${formatBytes(entry.downBytes)}` : "";
  const status =
    entry.status === null || entry.status === undefined ? "tunnel" : `→ ${entry.status}`;
  const error = entry.error ? ` ! ${entry.error}` : "";
  const subject =
    entry.kind === "connect" ? `CONNECT ${entry.target}` : `${entry.method} ${entry.url}`;
  return `${subject} ${status}${size}${duration}${error}`;
}

function renderStep(step, index, ctx) {
  const lines = [];
  const outcome = step.result;
  const status = outcome.timedOut
    ? `TIMEOUT after ${(outcome.durationMs / 1000).toFixed(1)}s`
    : `exit ${outcome.code}`;
  lines.push(`### ${index + 1}. \`sash ${step.args.join(" ")}\``);
  lines.push("");
  lines.push(`**${(outcome.durationMs / 1000).toFixed(1)}s · ${status}**`);
  lines.push("");

  const fileDiff = step.fileDiff;
  const changed = fileDiff.created.length + fileDiff.modified.length + fileDiff.deleted.length;
  if (changed === 0) {
    lines.push("- files: no change in any observed directory");
  } else {
    for (const entry of fileDiff.created) {
      const relative = path.relative(ctx.traceHome, entry.file);
      const inside = relative.startsWith("..") ? entry.file : relative;
      lines.push(
        `- \`+\` \`${inside.split(path.sep).join("/")}\` ${formatBytes(entry.size)}${
          annotate(inside) ? ` — ${annotate(inside)}` : ""
        }`,
      );
    }
    for (const entry of fileDiff.modified) {
      const relative = path.relative(ctx.traceHome, entry.file);
      const inside = relative.startsWith("..") ? entry.file : relative;
      lines.push(
        `- \`~\` \`${inside.split(path.sep).join("/")}\` ${formatBytes(entry.previousSize)} → ${formatBytes(entry.size)}${
          annotate(inside) ? ` — ${annotate(inside)}` : ""
        }`,
      );
    }
    for (const entry of fileDiff.deleted) {
      const relative = path.relative(ctx.traceHome, entry.file);
      const inside = relative.startsWith("..") ? entry.file : relative;
      lines.push(`- \`-\` \`${inside.split(path.sep).join("/")}\` — removed`);
    }
  }

  if (step.http.length) {
    lines.push("");
    lines.push("Outbound requests observed through the logging proxy:");
    lines.push("");
    lines.push("```");
    for (const entry of step.http) lines.push(formatHttp(entry));
    lines.push("```");
  }
  if (step.listeners) {
    lines.push("");
    lines.push("Listening sockets owned by this trace:");
    lines.push("");
    lines.push("```");
    lines.push(step.listeners);
    lines.push("```");
  }
  if (step.processGain.length || step.processLose.length) {
    if (step.processGain || step.processLose) {
      lines.push("");
      lines.push("Processes that appeared or disappeared (`*` marks a recorded pid):");
      lines.push("");
      lines.push("```");
      for (const line of step.processGain) lines.push(`+ ${line}`);
      for (const line of step.processLose) lines.push(`- ${line}`);
      lines.push("```");
    }
  }
  if (step.registryChanged) {
    lines.push("");
    lines.push("**Registry changed** (this should never happen in this scenario):");
    lines.push("");
    lines.push("```");
    lines.push(step.registryChanged);
    lines.push("```");
  }
  const logKeys = Object.keys(step.logGrowth);
  if (logKeys.length) {
    lines.push("");
    lines.push("Log output produced by this step:");
    lines.push("");
    for (const key of logKeys) {
      lines.push(`\`${key}\``);
      lines.push("");
      lines.push("```");
      lines.push(step.logGrowth[key].slice(-4000));
      lines.push("```");
    }
  }

  const output = outcome.stdout.trim() || outcome.stderr.trim();
  if (output) {
    lines.push("");
    lines.push("Command output:");
    lines.push("");
    lines.push("```");
    lines.push(output.slice(-6000));
    lines.push("```");
  }
  lines.push("");
  return lines.join("\n");
}

function renderReport(run) {
  const lines = [];
  lines.push("# Sash trace report");
  lines.push("");
  lines.push(`- date: ${run.startedAt}`);
  lines.push(`- cli: \`${run.cliLabel}\``);
  lines.push(`- scenario: \`${run.scenario}\``);
  lines.push(`- isolated data dir: \`${run.traceHome}\``);
  lines.push(`- shared control dir (read-only observation): \`${run.controlDir}\``);
  lines.push(
    `- ports in use: mixed ${run.ports.mixed}, controller ${run.ports.controller}, daemon ${run.ports.daemon}`,
  );
  lines.push(
    `- effective proxy env for the CLI: ${
      run.direct ? "none" : `HTTP_PROXY/HTTPS_PROXY -> 127.0.0.1:${run.proxyPort}`
    }`,
  );
  const proxyLabel = run.direct
    ? "none (--direct: no proxy env, as on a fresh machine)"
    : `127.0.0.1:${run.proxyPort}${run.via ? ` chained through ${run.via}` : " (direct)"}`;
  lines.push(`- outbound proxy: ${proxyLabel}`);
  lines.push(`- profile source: \`${run.profileUrl}\``);
  if (run.seededCore) {
    lines.push(
      `- **Core pre-seeded from \`${run.seededCore}\`**: the download step is skipped so the trace can isolate what happens after installation`,
    );
  }
  lines.push(`- system proxy and login startup: never written; registry read-only`);
  lines.push(
    "- caveat: the CLI runs from this repository's bundle, so Sash classifies the installation as `source`; checks and commands that need an npm-global install (autostart registration, `sash upgrade`) report that and are not exercised",
  );
  lines.push("");
  lines.push("## Step summary");
  lines.push("");
  lines.push("| # | command | duration | result | files +/-/~ | outbound |");
  lines.push("|---|---|---|---|---|---|");
  run.steps.forEach((step, index) => {
    const diff = step.fileDiff;
    lines.push(
      `| ${index + 1} | \`sash ${step.args.join(" ")}\` | ${(step.result.durationMs / 1000).toFixed(1)}s | ${
        step.result.timedOut ? "**timeout**" : step.result.code
      } | ${diff.created.length}/${diff.deleted.length}/${diff.modified.length} | ${step.http.length} |`,
    );
  });
  lines.push("");
  lines.push("## Steps");
  lines.push("");
  run.steps.forEach((step, index) => {
    lines.push(renderStep(step, index, run));
  });

  lines.push("## Final inventory of the data directory");
  lines.push("");
  lines.push("```");
  const inventory = [];
  walkFiles(run.traceHome, new Map()).forEach((stat, file) => {
    if (stat.isDirectory) return;
    inventory.push({ file, size: stat.size });
  });
  inventory.sort((a, b) => a.file.localeCompare(b.file));
  for (const entry of inventory) {
    const relative = path.relative(run.traceHome, entry.file).split(path.sep).join("/");
    const note = annotate(relative) || "(unclassified)";
    lines.push(`${relative.padEnd(42)} ${formatBytes(entry.size).padStart(10)}  ${note}`);
  }
  lines.push("```");
  lines.push("");
  lines.push("## What was not touched");
  lines.push("");
  lines.push(
    `- Windows registry keys read but never written: ${run.registryKeys.map((key) => `\`${key}\``).join(", ")}`,
  );
  lines.push(
    `- system proxy: untouched (this scenario never enables it; \`state/system-proxy.json\` stays absent)`,
  );
  lines.push(
    `- shared control dir \`${run.controlDir}\`: ${run.controlDirChanges.length === 0 ? "no change" : `${run.controlDirChanges.length} file(s) changed — shared with any real Sash instance, see below`}`,
  );
  if (run.controlDirChanges.length) {
    lines.push("");
    lines.push("```");
    for (const entry of run.controlDirChanges) lines.push(entry);
    lines.push("```");
  }
  if (run.tempLeftovers.length) {
    lines.push(
      `- \`sash*\` entries created or touched in the system temp dir during this run: ${run.tempLeftovers
        .map((name) => `\`${name}\``)
        .join(", ")}`,
    );
  } else {
    lines.push("- system temp dir: nothing new was created there");
  }
  if (run.registryChanges) {
    lines.push("");
    lines.push("**The Windows registry changed during this run:**");
    lines.push("");
    lines.push("```");
    lines.push(run.registryChanges);
    lines.push("```");
  }
  lines.push("");
  lines.push("## Raw evidence");
  lines.push("");
  for (const [label, file] of Object.entries(run.evidence)) lines.push(`- ${label}: \`${file}\``);
  lines.push("");
  return lines.join("\n");
}

/* main --------------------------------------------------------------------- */

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dataRoot = defaultDataRoot();
  const outDir = options.out
    ? path.resolve(options.out)
    : fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sash-trace-"));
  const traceHome = path.join(outDir, "home");
  if (samePath(traceHome, dataRoot))
    throw new Error(`Refusing to trace into the real data directory: ${dataRoot}`);
  fs.mkdirSync(traceHome, { recursive: true });

  const controlDir = process.platform === "win32" ? dataRoot : path.join(traceHome, "state");
  const distCli = path.join(repoRoot, "dist", "cli.js");
  const cliPath = options.fromSource ? path.join(repoRoot, "src", "cli.ts") : distCli;
  if (!options.fromSource && !fs.existsSync(distCli))
    throw new Error("dist/cli.js is missing; run npm run build or pass --from-source");

  const proxy = await startLoggingProxy({
    upstream: options.direct
      ? undefined
      : options.via
        ? parseHostPort(options.via, 8080)
        : undefined,
  });
  const fixture = await startFixtureSubscription();
  const steps = scenarioSteps(options.scenario, options.profile ?? fixture.url);
  const proxyEnv = options.direct
    ? {}
    : {
        HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
        HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
        http_proxy: `http://127.0.0.1:${proxy.port}`,
        https_proxy: `http://127.0.0.1:${proxy.port}`,
        NO_PROXY: "127.0.0.1,localhost,::1",
        no_proxy: "127.0.0.1,localhost,::1",
      };
  const env = {
    ...process.env,
    SASH_HOME: traceHome,
    SASH_DEVELOPMENT: "1",
    SASH_DEBUG: "1",
    ...proxyEnv,
  };
  if (options.direct) {
    // `--direct` must reproduce a machine with no proxy at all: a proxy this
    // harness inherited from its own shell would silently invalidate the run.
    for (const key of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "http_proxy",
      "https_proxy",
      "ALL_PROXY",
      "all_proxy",
      "NO_PROXY",
      "no_proxy",
    ]) {
      delete env[key];
    }
  }
  delete env.ALL_PROXY;
  delete env.all_proxy;

  const ctx = {
    traceHome,
    controlDir,
    env,
    verbose: options.verbose,
    stepTimeoutMs: options.stepTimeoutMs,
    node: process.execPath,
    loader: options.fromSource ? ["--import", "tsx"] : [],
    cliPath,
    proxy,
    repoRoot,
  };

  const run = {
    startedAt: new Date().toISOString(),
    scenario: options.scenario,
    cliLabel: options.fromSource ? "src/cli.ts (tsx)" : "dist/cli.js",
    traceHome,
    controlDir,
    ports: { mixed: 18890, controller: 18990, daemon: 28990 },
    proxyPort: proxy.port,
    via: options.via,
    direct: options.direct,
    profileUrl: options.profile ?? "built-in fixture",
    seededCore: options.seedCore ? path.resolve(options.seedCore) : null,
    registryKeys: REGISTRY_KEYS,
    steps: [],
    controlDirChanges: [],
    tempLeftovers: [],
    registryChanges: "",
    evidence: {},
  };

  const fileRoots = () => [traceHome];
  const sharedControlDir = !samePath(controlDir, traceHome);
  const controlBefore = sharedControlDir ? captureControlEntries(controlDir) : [];
  const registryBefore = captureRegistry();

  if (options.seedCore) {
    const source = path.resolve(options.seedCore);
    const coreName = process.platform === "win32" ? "mihomo.exe" : "mihomo";
    fs.mkdirSync(path.join(traceHome, "bin"), { recursive: true });
    fs.mkdirSync(path.join(traceHome, "state"), { recursive: true });
    fs.copyFileSync(path.join(source, "bin", coreName), path.join(traceHome, "bin", coreName));
    fs.copyFileSync(
      path.join(source, "state", "install.json"),
      path.join(traceHome, "state", "install.json"),
    );
    console.log(`[trace] Core pre-seeded from ${source}`);
  }

  console.log(`[trace] data dir    ${traceHome}`);
  console.log(`[trace] control dir ${controlDir}`);
  console.log(
    `[trace] proxy       127.0.0.1:${proxy.port}${options.via ? ` -> ${options.via}` : ""}`,
  );
  console.log(`[trace] scenario    ${options.scenario}`);

  let cleanedUp = false;
  try {
    for (const [index, step] of steps.entries()) {
      const args = step.args();
      const beforeFiles = captureFiles(fileRoots());
      const beforeLogs = captureLogSizes(traceHome);
      const beforeRegistry = captureRegistry();
      const beforeProcesses = captureProcesses(readPids(traceHome));
      const httpIndex = proxy.requests.length;

      console.log(`[trace] ${index + 1}/${steps.length} sash ${args.join(" ")}`);
      const result = await execCli(args, ctx);

      const afterProcesses = captureProcesses(readPids(traceHome));
      const record = {
        name: typeof step.name === "function" ? step.name() : step.name,
        args,
        result,
        fileDiff: diffFiles(beforeFiles, captureFiles(fileRoots())),
        registryChanged: diffRegistry(beforeRegistry, captureRegistry()),
        http: proxy.requests.slice(httpIndex),
        listeners: captureListeners(readPids(traceHome)),
        processGain: [],
        processLose: [],
        logGrowth: readLogGrowth(traceHome, beforeLogs),
      };
      const beforeLines = new Set(beforeProcesses.split("\n").filter(Boolean));
      const afterLines = new Set(afterProcesses.split("\n").filter(Boolean));
      record.processGain = [...afterLines].filter((line) => !beforeLines.has(line));
      record.processLose = [...beforeLines].filter((line) => !afterLines.has(line));
      run.steps.push(record);
    }
  } finally {
    const last = run.steps.at(-1);
    if (last && !last.args.includes("stop")) {
      console.log("[trace] cleanup: sash stop");
      const result = await execCli(["stop"], ctx);
      cleanedUp = result.code === 0;
      if (!cleanedUp) console.warn(`[trace] cleanup stop exited ${result.code}`);
    } else {
      cleanedUp = true;
    }
    await proxy.close();
    await fixture.close();
  }

  const controlAfter = captureControlEntries(controlDir);
  if (sharedControlDir) {
    for (const name of controlAfter.filter((entry) => !controlBefore.includes(entry)))
      run.controlDirChanges.push(`+ ${name}`);
    for (const name of controlBefore.filter((entry) => !controlAfter.includes(entry)))
      run.controlDirChanges.push(`- ${name}`);
  }

  const registryAfter = captureRegistry();
  const registryDiff = diffRegistry(registryBefore, registryAfter);
  if (registryDiff) {
    run.registryChanges = registryDiff;
    console.warn("[trace] WARNING: the registry changed during this trace");
  }

  run.tempLeftovers = captureTempEntries(outDir, Date.parse(run.startedAt));

  const reportFile = path.join(outDir, "trace-report.md");
  const jsonFile = path.join(outDir, "trace.json");
  run.evidence = { report: reportFile, json: jsonFile, dataDir: traceHome };
  fs.writeFileSync(reportFile, renderReport(run));
  fs.writeFileSync(jsonFile, `${JSON.stringify(run, null, 2)}\n`);

  const failed = run.steps.filter((step) => step.result.code !== 0 || step.result.timedOut);
  console.log("");
  console.log(
    `[trace] ${run.steps.length} steps, ${failed.length} non-zero${cleanedUp ? "" : " (cleanup stop failed)"}`,
  );
  if (failed.length) {
    for (const step of failed)
      console.log(
        `[trace]   sash ${step.args.join(" ")} -> ${step.result.timedOut ? "timeout" : step.result.code}`,
      );
  }
  console.log(`[trace] report  ${reportFile}`);
  console.log(`[trace] json    ${jsonFile}`);
  console.log(`[trace] data    ${traceHome}`);
  if (options.clean && cleanedUp) {
    fs.rmSync(traceHome, { recursive: true, force: true });
    console.log("[trace] data dir removed (--clean)");
  } else {
    console.log("[trace] data dir kept for inspection; delete it when you are done");
  }
}

function readPids(traceHome) {
  const pids = [];
  for (const relative of ["state/sashd.pid", "state/sash.pid"]) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(traceHome, relative), "utf8"));
      if (typeof value?.pid === "number") pids.push(value.pid);
    } catch {
      /* absent */
    }
  }
  return pids;
}

function diffRegistry(before, after) {
  if (!before || !after) return "";
  const lines = [];
  for (let index = 0; index < before.length; index += 1) {
    if (before[index].bytes === after[index].bytes) continue;
    lines.push(`key: ${before[index].key}`);
    lines.push("--- before");
    lines.push(before[index].text);
    lines.push("--- after");
    lines.push(after[index].text);
  }
  return lines.join("\n");
}

await main();
