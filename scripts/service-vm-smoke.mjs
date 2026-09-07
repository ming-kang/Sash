import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ACK = "I_ACKNOWLEDGE_DISPOSABLE_WINDOWS_VM_SERVICE_TEST";

// Pure guard: executed before filesystem writes, subprocesses, network or native imports.
export function guard(args, env, platform) {
  if (
    platform !== "win32" ||
    env.GITHUB_ACTIONS !== "true" ||
    env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    env.SASH_VM_ACK !== ACK
  ) {
    throw new Error(
      "Requires acknowledged disposable GitHub-hosted Windows VM; local/self-hosted execution forbidden",
    );
  }
  if (!env.RUNNER_TEMP || !path.win32.isAbsolute(env.RUNNER_TEMP))
    throw new Error("Absolute RUNNER_TEMP required");
  if (env.SASH_HOME) throw new Error("Pre-existing SASH_HOME forbidden");
  if (args.length !== 0) throw new Error("No arguments accepted; use workflow inputs");
  const version = env.SASH_VM_CORE_VERSION ?? "";
  if (
    version &&
    (version.trim() !== version || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
  )
    throw new Error("Core version must be a strict stable vX.Y.Z tag");
  return version;
}

export function sanitizedEnvironment(env) {
  const names = new Set([
    "systemroot",
    "windir",
    "path",
    "pathext",
    "temp",
    "tmp",
    "userprofile",
    "localappdata",
    "appdata",
    "runner_temp",
    "github_actions",
    "runner_environment",
    "sash_vm_ack",
  ]);
  return Object.fromEntries(Object.entries(env).filter(([name]) => names.has(name.toLowerCase())));
}

async function main() {
  const version = guard(process.argv.slice(2), process.env, process.platform);
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const env = sanitizedEnvironment(process.env);
  let phase = "preflight";
  let installed = false;
  let cleanupFailed = false;
  let operationPending = false;
  const passed = [];
  // Captured output is deliberately never printed: it can contain root paths and secrets.
  const run = (exe, args, timeout = 180000) =>
    new Promise((resolve, reject) => {
      const child = spawn(exe, args, {
        cwd: repo,
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let bytes = 0;
      let exceeded = false;
      // Do not kill on deadline: only public verified shutdown may terminate Sash.
      const timer = setTimeout(() => {
        operationPending = true;
        reject(new Error("bounded operation deadline exceeded; preserve evidence"));
      }, timeout);
      child.stdout.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes < 1024 * 1024) output += chunk;
        else exceeded = true;
      });
      child.stderr.on("data", () => {});
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("subprocess could not run"));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 || exceeded)
          reject(new Error("subprocess failed (private output withheld)"));
        else resolve(output.trim());
      });
    });
  const ps = (script) =>
    run(
      path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(`$ErrorActionPreference='Stop'; ${script}`, "utf16le").toString("base64"),
      ],
      30000,
    );
  const helper = path.join(repo, ".native", "windows-amd64", "sash-service.exe");
  const launcher = path.join(repo, ".native", "service-vm-runner.exe");
  const cliArgs = ["--import", "tsx", path.join(repo, "src", "cli.ts")];
  const cli = (...args) => run(process.execPath, [...cliArgs, ...args]);
  const ordinary = (...args) => run(launcher, [process.execPath, ...cliArgs, ...args]);
  const nativeStatus = async () =>
    JSON.parse(await run(helper, ["status", "--root", env.SASH_HOME]));
  const idle = async () => {
    const status = await nativeStatus();
    assert.equal(status.running, true);
    assert.equal(status.core.running, false);
    assert.notEqual(status.core.tunActive, true); // Stopped Core has no tunActive observation.
    assert.equal(JSON.parse(await ordinary("service", "status", "--json")).state, "ready");
    const settings = JSON.parse(readFileSync(path.join(env.SASH_HOME, "sash.json"), "utf8"));
    assert.equal(settings.tun, false);
    assert.equal(settings.systemProxy, false);
    assert.equal(settings.allowLan, false);
  };
  try {
    const info = JSON.parse(
      await ps(`
      $i=[Security.Principal.WindowsIdentity]::GetCurrent();
      if (!([Security.Principal.WindowsPrincipal]::new($i)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator token required' }
      $machine=Get-CimInstance Win32_ComputerSystem;
      if ($machine.Manufacturer -ne 'Microsoft Corporation' -or $machine.Model -ne 'Virtual Machine') { throw 'Expected hosted Microsoft VM' }
      $pf=[Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles);
      if (Get-Service -Name SashService -ErrorAction SilentlyContinue) { throw 'Existing service forbidden' }
      if (Get-ChildItem -LiteralPath $pf -Filter 'SashService*' -Force) { throw 'Existing protected root/stage forbidden' }
      $default=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) 'Sash';
      if (Test-Path -LiteralPath $default) { throw 'Existing user root forbidden' }
      if (Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(sash|sashd|sash-service|mihomo|core)(\\.exe)?$' -or ($_.Name -eq 'node.exe' -and $_.CommandLine -match '(sashd|daemon-entry|[\\\\/]dist[\\\\/]cli\\.js|[\\\\/]src[\\\\/]cli\\.ts)') }) { throw 'Possible active user instance' }
      @{sid=$i.User.Value; protectedRoot=(Join-Path $pf 'SashService')} | ConvertTo-Json -Compress
    `),
    );
    assert.match(info.sid, /^S-1-5-21-\d+-\d+-\d+-\d+$/);
    // Proof precedes root allocation and installation. No elevated fallback or silent skip.
    phase = "ordinary-token-proof (requires same-SID UAC linked token; no elevated fallback)";
    await run(launcher, [process.execPath, "--version"]);
    passed.push("same-SID genuinely unelevated token");
    phase = "fresh-private-root";
    const temp = realpathSync(process.env.RUNNER_TEMP);
    env.SASH_HOME = mkdtempSync(path.join(temp, "sash-service-vm-"));
    const encoded = Buffer.from(env.SASH_HOME).toString("base64");
    await ps(
      `$r=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $sid=[Security.Principal.SecurityIdentifier]::new('${info.sid}'); $acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')); Set-Acl -LiteralPath $r -AclObject $acl; $actual=Get-Acl -LiteralPath $r; if ($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or !$actual.AreAccessRulesProtected) { throw 'Private root ACL verification failed' }`,
    );
    const listeners = [];
    try {
      for (let i = 0; i < 3; i++) {
        const server = net.createServer();
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        listeners.push(server);
      }
      const ports = listeners.map((server) => server.address().port);
      assert(ports.every((port) => ![7890, 9090, 19090].includes(port)));
      // Existing atomic settings machinery, imported only after the complete effect guard.
      const { saveSettings, generateSecret, DEFAULT_SETTINGS } = await import("../src/settings.ts");
      const { sashLayout } = await import("../src/paths.ts");
      saveSettings(
        {
          ...DEFAULT_SETTINGS,
          mixedPort: ports[0],
          controller: `127.0.0.1:${ports[1]}`,
          daemonPort: ports[2],
          secret: generateSecret(),
          daemonSecret: generateSecret(),
          tun: false,
          systemProxy: false,
          allowLan: false,
        },
        sashLayout(env.SASH_HOME),
      );
    } finally {
      await Promise.all(listeners.map((server) => new Promise((resolve) => server.close(resolve))));
    }
    const installArgs = [
      "service",
      "install",
      "--helper",
      helper,
      ...(version ? ["--core-version", version] : []),
    ];
    phase = "verified-release-install";
    await cli(...installArgs); // Production stageCore verifies upstream release digests.
    installed = true;
    await idle();
    passed.push("install leaves service idle without Core/TUN");
    const running = async () => {
      const status = JSON.parse(await ordinary("status", "--json"));
      assert.equal(status.complete, true);
      assert.equal(status.core.running, true);
      assert.equal(status.core.healthy, true);
      assert.equal(status.tun.desired, false);
      assert.equal(status.tun.active, false);
      assert.equal(status.systemProxy.desired, false);
      const native = await nativeStatus();
      assert.equal(native.core.tunActive, false);
      const { default: YAML } = await import("yaml");
      const config = YAML.parse(readFileSync(path.join(env.SASH_HOME, "config.yaml"), "utf8"));
      assert.equal(config.tun, undefined); // Default profile omits TUN entirely when disabled.
      assert.deepEqual(config.proxies, []);
      assert.deepEqual(config.rules, ["MATCH,PROXY"]);
      assert.equal(config["proxy-providers"], undefined);
      assert.equal(config["rule-providers"], undefined);
      assert.equal(config["allow-lan"], false);
      // The HTTP request also runs under the ordinary token, not the admin harness.
      const probe = `const s=JSON.parse(require('node:fs').readFileSync(require('node:path').join(process.env.SASH_HOME,'sash.json'),'utf8')); const h=require('node:http'); const q=h.get({hostname:'127.0.0.1',port:s.daemonPort,path:'/core/api/configs',headers:{Authorization:'Bearer '+s.daemonSecret}},r=>{let b='';r.on('data',x=>{b+=x;if(b.length>1048576)process.exit(2)});r.on('end',()=>{try{const c=JSON.parse(b);if(r.statusCode!==200||c.tun?.enable!==false||c.secret)process.exit(3)}catch{process.exit(4)}})});q.setTimeout(10000,()=>process.exit(5));q.on('error',()=>process.exit(6));`;
      await run(launcher, [process.execPath, "-e", probe]);
    };
    phase = "ordinary-start-and-gateway";
    await ordinary("start");
    await running();
    phase = "ordinary-restart-and-gateway";
    await ordinary("restart");
    await running();
    passed.push("ordinary start/status/configs gateway/restart; observed TUN off");
    phase = "verified-host-stop-and-repair";
    const before = await nativeStatus();
    assert.equal(before.root.toLowerCase(), env.SASH_HOME.toLowerCase());
    assert.equal(before.compatible, true);
    // Fault injection only for our verified registration. Never target a PID or process name.
    const protectedEncoded = Buffer.from(
      path.join(info.protectedRoot, "sash-service.exe"),
    ).toString("base64");
    await ps(
      `$expected=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${protectedEncoded}')); $s=Get-CimInstance Win32_Service -Filter "Name='SashService'"; if (!$s -or $s.StartName -ne 'LocalSystem' -or $s.PathName -ne ('"'+$expected+'" run')) { throw 'SCM identity mismatch' }; Stop-Service -Name SashService; (Get-Service -Name SashService).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(20))`,
    );
    await cli(...installArgs);
    await idle();
    await ordinary("start");
    await running();
    passed.push("stopped-host administrative repair returns idle; ordinary restart works");
    phase = "ordinary-stop";
    await ordinary("stop");
    await idle();
    phase = "uninstall";
    await cli("service", "uninstall");
    installed = false;
    await ps(
      "if (Get-Service -Name SashService -ErrorAction SilentlyContinue) { throw 'SCM registration retained' }",
    );
    assert.equal(existsSync(info.protectedRoot), false);
    assert.equal(JSON.parse(await ordinary("service", "status", "--json")).state, "not-installed");
    passed.push("ordinary stop; uninstall removes SCM registration and own protected root");
    phase = "complete";
  } finally {
    if (operationPending) cleanupFailed = true;
    if (installed && !operationPending) {
      try {
        // No forced repair, deletion, taskkill, or PID/name termination on failure.
        await ordinary("stop");
        await cli("service", "uninstall");
      } catch {
        cleanupFailed = true;
      }
    }
    console.log(
      JSON.stringify({
        phase,
        passed,
        cleanup: cleanupFailed
          ? "verified cleanup failed; evidence retained on disposable VM"
          : installed
            ? "public cleanup completed"
            : phase === "complete"
              ? "uninstall and absence verified"
              : "no cleanup attempted; unconfirmed or partial state may remain",
        evidence:
          "private data retained on VM only; no upload; partial install failures require inspection",
      }),
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(
      "VM acceptance failed; private subprocess output withheld. See phase report; never force cleanup.",
    );
    process.exitCode = 1;
  });
}
