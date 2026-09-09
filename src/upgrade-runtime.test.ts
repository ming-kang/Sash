import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import YAML from "yaml";
import { MihomoApi } from "./api.js";
import { extractCoreArchive, verifyCoreExecutable, writeInstallRecord } from "./core.js";
import { SashDaemonClient } from "./daemon-client.js";
import { stopDaemonFromCli } from "./daemon-lifecycle.js";
import { fetchWithRetry } from "./http.js";
import { inspectInstallation, npmPackageRoot, npmShimPaths } from "./installation.js";
import { listInstallationInstances } from "./installation-registry.js";
import { sashLayout } from "./paths.js";
import { isProcessAlive } from "./process.js";
import { SashClient } from "./sash-client.js";
import { createSashUpgradeJournal } from "./self-upgrade.js";
import { createTestState, testSettings } from "./test-state.test.js";
import { readUpgradeAuthorization } from "./upgrade-access.js";
import { runUpgradeCommand, upgradeChildEnv } from "./upgrade-command.js";
import { upgradeTransactionPaths } from "./upgrade-paths.js";
import { SashUpgradeTransaction, type UpgradeResult } from "./upgrade-transaction.js";

describe("real isolated Sash daemon upgrades", () => {
  const parent = fs.realpathSync(os.tmpdir());
  let root: string;
  let template: string;
  let manifest: Record<string, unknown>;
  const installations: Array<{ id: string; packageRoot: string }> = [];
  before(async () => {
    root = fs.mkdtempSync(path.join(parent, "sash-upgrade-runtime-"));
    template = path.join(root, "template");
    const repository = path.resolve(import.meta.dirname, "..");
    manifest = JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const compile = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) compile(file);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          const target = path.join(
            template,
            "dist",
            path.relative(path.join(repository, "src"), file).replace(/\.ts$/, ".js"),
          );
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(
            target,
            ts.transpileModule(fs.readFileSync(file, "utf8"), {
              compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.ESNext,
                removeComments: true,
              },
            }).outputText,
          );
        }
      }
    };
    compile(path.join(repository, "src"));
    const lock = JSON.parse(
      fs.readFileSync(path.join(repository, "package-lock.json"), "utf8"),
    ) as {
      packages: Record<string, { dev?: boolean; devOptional?: boolean }>;
    };
    // Preserve npm's complete installed production tree, including transitive dependencies.
    for (const [location, info] of Object.entries(lock.packages)) {
      if (!location.startsWith("node_modules/") || info.dev || info.devOptional) continue;
      fs.cpSync(path.join(repository, location), path.join(template, location), {
        recursive: true,
        dereference: true,
      });
    }
    await runUpgradeCommand(
      process.execPath,
      [path.join(repository, "scripts", "build-upgrade-worker.mjs"), path.join(template, "dist")],
      { cwd: repository, purpose: "Build isolated daemon upgrade helper", timeoutMs: 30_000 },
    );
    // Only the fixture package uses these adapters. No real OS proxy or login registration is touched.
    fs.writeFileSync(
      path.join(template, "dist", "sysproxy", "factory.js"),
      "export function createSystemProxyBackend() { return { supported: false }; }\n",
    );
    fs.writeFileSync(
      path.join(template, "dist", "sysproxy", "windows-connections.js"),
      "export async function inspectWindowsProxyConnections() { return { supported: false }; }\n",
    );
    fs.writeFileSync(
      path.join(template, "dist", "autostart", "windows-registry.js"),
      'export async function readWindowsRegistration() { return { command: null, disabled: false }; }\nexport async function setWindowsRegistration() { throw new Error("OS integration is disabled in the upgrade fixture"); }\nexport function windowsSystemPath() { throw new Error("OS integration is disabled in the upgrade fixture"); }\n',
    );
    const ui = path.join(template, "dist", "ui");
    fs.mkdirSync(path.join(ui, "assets"), { recursive: true });
    fs.mkdirSync(path.join(ui, ".vite"));
    fs.writeFileSync(
      path.join(ui, "index.html"),
      '<script type="module" src="./assets/app.js"></script><link rel="stylesheet" href="./assets/app.css">',
    );
    fs.writeFileSync(
      path.join(ui, "assets", "app.js"),
      'document.body.textContent = "Sash fixture";\n',
    );
    fs.writeFileSync(path.join(ui, "assets", "app.css"), "body { color: black; }\n");
    fs.writeFileSync(
      path.join(ui, ".vite", "manifest.json"),
      JSON.stringify({ "index.html": { file: "assets/app.js", css: ["assets/app.css"] } }),
    );
  });
  after(async () => {
    for (const installation of installations)
      assert.equal(
        listInstallationInstances(installation.id, installation.packageRoot).filter((record) =>
          isProcessAlive(record.pid),
        ).length,
        0,
        "Fixture daemons must stop before their files are removed",
      );
    assert.equal(path.dirname(fs.realpathSync(root)), parent);
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  async function install(prefix: string, version: string, badDaemon = false): Promise<string> {
    const packageRoot = npmPackageRoot(prefix);
    await fs.promises.cp(template, packageRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ ...manifest, version }),
    );
    if (badDaemon) {
      const entry = path.join(packageRoot, "dist", "daemon", "entry.js");
      const source = fs.readFileSync(entry, "utf8");
      const start = "export async function runDaemon(opts = {}) {";
      assert.ok(source.includes(start));
      fs.writeFileSync(
        entry,
        source.replace(
          start,
          `${start}\nif (process.env.SASH_UPGRADE_TRANSACTION) throw new Error("Candidate daemon startup failed");`,
        ),
      );
    }
    for (const file of npmShimPaths(prefix)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (process.platform === "win32")
        fs.writeFileSync(file, "fixture npm target: node_modules/@astralyn/sash/dist/cli.js\n");
      else fs.symlinkSync("../lib/node_modules/@astralyn/sash/dist/cli.js", file);
    }
    return packageRoot;
  }

  it("runs doctor JSON against an isolated installed package without starting management", async () => {
    const prefix = path.join(root, "doctor-prefix");
    const packageRoot = await install(prefix, "1.0.0");
    const layout = sashLayout(path.join(root, "doctor-data"));
    const sockets = await Promise.all(
      [0, 1, 2].map(async () => {
        const server = net.createServer();
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        return server;
      }),
    );
    const ports = sockets.map((server) => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      return address.port;
    });
    await Promise.all(
      sockets.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    const [daemonPort, mixedPort, controllerPort] = ports;
    assert.ok(daemonPort && mixedPort && controllerPort);
    createTestState(
      layout,
      testSettings({ daemonPort, mixedPort, controller: `127.0.0.1:${controllerPort}` }),
    );
    const saved = fs.readFileSync(layout.settingsFile);
    const output = await runUpgradeCommand(
      process.execPath,
      [path.join(packageRoot, "dist", "cli.js"), "doctor", "--json"],
      {
        cwd: root,
        purpose: "Inspect an isolated installation",
        env: { ...process.env, SASH_HOME: layout.root },
      },
    );
    const result = JSON.parse(output) as { healthy: boolean; complete: boolean };
    assert.equal(result.healthy, true);
    assert.equal(result.complete, true);
    assert.deepEqual(fs.readFileSync(layout.settingsFile), saved);
    assert.equal(fs.existsSync(layout.daemonPidFile), false);
    assert.equal(fs.existsSync(layout.coreExe), false);
    fs.writeFileSync(layout.settingsFile, "{ corrupt");
    await assert.rejects(
      runUpgradeCommand(
        process.execPath,
        [path.join(packageRoot, "dist", "cli.js"), "doctor", "--json"],
        {
          cwd: root,
          purpose: "Diagnose an isolated damaged manifest",
          env: { ...process.env, SASH_HOME: layout.root },
        },
      ),
      /manifest.*error/,
    );
    assert.equal(fs.readFileSync(layout.settingsFile, "utf8"), "{ corrupt");
  });

  const scenarios = [
    { name: "success", badDaemon: false, boundary: undefined },
    { name: "health-failure", badDaemon: true, boundary: undefined },
    ...[
      "instance-reserved:0",
      "instance-reserved:1",
      "instance-stopped:0",
      "instance-stopped:1",
      "instance-restored:0",
      "instance-restored:1",
      "instance-committed:0",
      "instance-committed:1",
      "instance-handoff-cleaned:0",
      "instance-handoff-cleaned:1",
    ].map((boundary) => ({ name: boundary.replace(":", "-"), badDaemon: false, boundary })),
  ];
  for (const { name, badDaemon, boundary } of scenarios) {
    it(`preserves two management daemons and exact saved state: ${name}`, {
      timeout: 180_000,
    }, async (t) => {
      const prefix = path.join(root, `${name} 中文`);
      const packageRoot = await install(prefix, "1.0.0");
      const installation = inspectInstallation({ packageRoot });
      assert.equal(installation.kind, "npm-global");
      if (installation.kind !== "npm-global")
        throw new Error("Fixture installation is not global npm");
      installations.push(installation);
      const instances = [];
      for (let i = 0; i < 2; i += 1) {
        const listener = net.createServer();
        await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
        const address = listener.address();
        assert.ok(address && typeof address === "object");
        const port = address.port;
        await new Promise<void>((resolve) => listener.close(() => resolve()));
        const layout = sashLayout(path.join(root, `${name}-data-${i}`));
        const settings = testSettings({
          daemonPort: port,
          mixedPort: 28780 + i * 2,
          controller: `127.0.0.1:${28781 + i * 2}`,
        });
        createTestState(layout, settings);
        instances.push({ layout, settings });
      }
      try {
        for (const instance of instances)
          await runUpgradeCommand(
            process.execPath,
            [path.join(packageRoot, "dist", "cli.js"), "web", "--no-open"],
            {
              cwd: instance.layout.root,
              env: { ...process.env, SASH_HOME: instance.layout.root },
              purpose: "Start isolated management daemon",
              timeoutMs: 30_000,
            },
          );
        const before = listInstallationInstances(installation.id, packageRoot);
        assert.equal(before.length, 2);
        const saved = instances.map(({ layout }) => fs.readFileSync(layout.settingsFile));
        const journal = createSashUpgradeJournal(installation, "2.0.0");
        const target = {
          name: "@astralyn/sash",
          version: "2.0.0",
          nodeRange: ">=24",
          upgradeProtocol: 1,
          tarball: "https://registry.npmjs.org/@astralyn/sash/-/sash-2.0.0.tgz",
          integrity: { algorithm: "sha512", digest: "0".repeat(128) },
        } as const;
        let result: UpgradeResult;
        if (boundary) {
          const paths = upgradeTransactionPaths(prefix, journal.transactionId);
          const staged = await install(paths.stage, "2.0.0");
          const script = path.join(root, `${name}-interrupt.mjs`);
          const module = (file: string) =>
            JSON.stringify(pathToFileURL(path.join(import.meta.dirname, file)).href);
          fs.writeFileSync(
            script,
            [
              `import { readUpgradeJournal } from ${module("upgrade-journal.ts")};`,
              `import { SashUpgradeTransaction } from ${module("upgrade-transaction.ts")};`,
              `const journal = readUpgradeJournal(${JSON.stringify(prefix)});`,
              `const result = await new SashUpgradeTransaction(journal, {`,
              `  stagePackage: async () => ${JSON.stringify(staged)},`,
              `  onBoundary: (name) => { if (name === ${JSON.stringify(boundary)}) process.exit(77); },`,
              `}).run(${JSON.stringify(target)});`,
              `process.stderr.write(JSON.stringify(result)); process.exit(78);`,
            ].join("\n"),
          );
          const child = spawnSync(
            process.execPath,
            ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href, script],
            {
              cwd: root,
              env: upgradeChildEnv(),
              encoding: "utf8",
              timeout: 90_000,
              windowsHide: true,
            },
          );
          assert.equal(child.status, 77, child.error?.message ?? child.stderr);
          result = JSON.parse(
            await runUpgradeCommand(
              process.execPath,
              [paths.worker, "--recover", prefix, "--json"],
              {
                cwd: root,
                purpose: "Recover isolated running instances after updater exit",
                timeoutMs: 90_000,
              },
            ),
          ) as UpgradeResult;
        } else {
          result = await new SashUpgradeTransaction(journal, {
            stagePackage: async ({ prefix, transactionId }) =>
              install(upgradeTransactionPaths(prefix, transactionId).stage, "2.0.0", badDaemon),
            onBoundary: async (name) => {
              if (name !== "startup-barrier-published") return;
              const competing = sashLayout(
                path.join(root, `${badDaemon ? "rollback" : "success"}-competing`),
              );
              await assert.rejects(
                runUpgradeCommand(
                  process.execPath,
                  [path.join(packageRoot, "dist", "daemon-entry.js")],
                  {
                    cwd: root,
                    purpose: "Attempt a start during upgrade",
                    timeoutMs: 10_000,
                    env: { ...process.env, SASH_HOME: competing.root },
                  },
                ),
                /upgrade is unfinished/,
              );
              assert.equal(fs.existsSync(competing.settingsFile), false);
            },
          }).run(target);
        }
        const committed =
          !badDaemon &&
          (!boundary ||
            boundary.startsWith("instance-committed:") ||
            boundary.startsWith("instance-handoff-cleaned:"));
        const expectedVersion = committed ? "2.0.0" : "1.0.0";
        assert.equal(
          result.outcome,
          boundary ? "recovered" : badDaemon ? "failed" : "upgraded",
          result.error,
        );
        assert.equal(result.version, expectedVersion, result.error);
        assert.equal(result.recoveryRequired, false, result.error);
        if (badDaemon)
          assert.match(result.error ?? "", /restore exited|Candidate daemon startup failed/);
        const after = listInstallationInstances(installation.id, packageRoot);
        assert.equal(after.length, 2);
        for (const [index, instance] of instances.entries()) {
          assert.deepEqual(fs.readFileSync(instance.layout.settingsFile), saved[index]);
          assert.equal(fs.existsSync(instance.layout.coreExe), false);
          const health = await new SashDaemonClient(
            instance.settings.daemonPort,
            instance.settings.daemonSecret,
          ).health();
          assert.equal(health.version, expectedVersion);
          if (!boundary?.startsWith("instance-reserved:"))
            assert.ok(!before.some((record) => record.bootId === health.token));
        }
      } catch (error) {
        t.diagnostic(error instanceof Error ? (error.stack ?? error.message) : String(error));
        throw error;
      } finally {
        const authorization = readUpgradeAuthorization(installation.id);
        for (const instance of instances) {
          const record = listInstallationInstances(installation.id, packageRoot).find(
            (record) => record.dataDir === instance.layout.root && isProcessAlive(record.pid),
          );
          if (record && authorization) {
            const client = new SashDaemonClient(record.port, instance.settings.daemonSecret);
            const access = {
              transactionId: authorization.transactionId,
              installationId: authorization.installationId,
              grant: authorization.grant,
            };
            const status = await client.upgradeRuntime("status", access);
            if (status.phase !== "none" && status.phase !== "committed") {
              await client.upgradeRuntimeAction("stop", access);
              const deadline = Date.now() + 10_000;
              while (isProcessAlive(record.pid) && Date.now() < deadline)
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
          }
          assert.equal(await stopDaemonFromCli(instance), true);
        }
        const remaining = listInstallationInstances(installation.id, packageRoot);
        assert.equal(
          remaining.length,
          0,
          JSON.stringify(
            remaining.map(({ pid, dataDir }) => ({ pid, dataDir, alive: isProcessAlive(pid) })),
          ),
        );
      }
    });
  }

  // Opt-in smoke: an independently downloaded official archive and its published SHA-256.
  const coreArchive = process.env.SASH_TEST_CORE_ARCHIVE;
  if (coreArchive)
    for (const badDaemon of [false, true]) {
      it(`preserves real Core configuration, choices and browser access (rollback: ${badDaemon})`, {
        timeout: 180_000,
      }, async () => {
        const archive = fs.realpathSync(coreArchive);
        assert.ok(
          archive.startsWith(`${parent}${path.sep}`),
          "The Core fixture must be in a temporary directory",
        );
        const expectedDigest = process.env.SASH_TEST_CORE_SHA256;
        assert.match(expectedDigest ?? "", /^[a-f0-9]{64}$/);
        assert.equal(crypto.hash("sha256", fs.readFileSync(archive)), expectedDigest);
        const version = process.env.SASH_TEST_CORE_VERSION;
        assert.match(version ?? "", /^v\d+\.\d+\.\d+$/);
        assert.ok(version);
        const prefix = path.join(root, `core-${badDaemon ? "rollback" : "success"} 中文`);
        const packageRoot = await install(prefix, "1.0.0");
        const installation = inspectInstallation({ packageRoot });
        assert.ok(installation.kind === "npm-global");
        installations.push(installation);
        const layout = sashLayout(
          path.join(root, `core-${badDaemon ? "rollback" : "success"}-data`),
        );
        const sockets = await Promise.all(
          [0, 1, 2, 3].map(async () => {
            const server = net.createServer();
            await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
            return server;
          }),
        );
        const ports = sockets.map((server) => {
          const address = server.address();
          assert.ok(address && typeof address === "object");
          assert.ok(![7890, 9090, 19090].includes(address.port));
          return address.port;
        });
        await Promise.all(
          sockets.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
        );
        const [daemonPort, mixedPort, controllerPort, pendingPort] = ports;
        assert.ok(daemonPort && mixedPort && controllerPort && pendingPort);
        const settings = testSettings({
          daemonPort,
          mixedPort,
          controller: `127.0.0.1:${controllerPort}`,
          systemProxy: false,
          allowLan: false,
        });
        createTestState(layout, settings);
        fs.mkdirSync(layout.binDir, { recursive: true });
        const binarySha256 = await extractCoreArchive(
          archive,
          path.basename(archive),
          layout.coreExe,
        );
        verifyCoreExecutable(layout.coreExe, 20_000, version);
        writeInstallRecord(
          { coreVersion: version, installedAt: new Date().toISOString(), sha256: binarySha256 },
          layout,
        );
        const client = new SashClient({
          baseUrl: `http://127.0.0.1:${daemonPort}`,
          token: () => settings.daemonSecret,
          fetchFn: async (url, init) => {
            const response = await fetchWithRetry(url, {
              ...init,
              direct: true,
              manualRedirect: true,
              deadlineMs: init.timeoutMs,
            });
            return { status: response.statusCode, text: () => response.text(1024 * 1024) };
          },
        });
        try {
          await runUpgradeCommand(
            process.execPath,
            [path.join(packageRoot, "dist", "cli.js"), "web", "--no-open"],
            {
              cwd: root,
              purpose: "Start isolated Core management",
              env: { ...process.env, SASH_HOME: layout.root },
            },
          );
          const content =
            'mode: rule\nproxy-groups:\n  - name: "Smoke / 中文"\n    type: select\n    proxies: [DIRECT, REJECT]\nrules: ["MATCH,DIRECT"]\n';
          const imported = await client.importProfile("smoke", content);
          await client.activateProfile(imported.profile.id);
          await client.startCore();
          const controller = new MihomoApi(settings.controller, settings.secret);
          await controller.restoreRuntimeState({
            mode: "global",
            selections: { "Smoke / 中文": "REJECT" },
          });
          const runtime = await controller.runtimeState();
          const applied = fs.readFileSync(layout.configFile);
          const generated = YAML.parse(applied.toString()) as { tun?: { enable?: boolean } };
          assert.equal(generated.tun?.enable, false);
          await client.patchSettings({ mixedPort: pendingPort });
          await client.writeProfileContent(
            imported.profile.id,
            content.replace("MATCH,DIRECT", "MATCH,REJECT"),
            imported.profile.revision,
          );
          assert.equal((await client.status(true)).configuration.pending, true);
          const saved = fs.readFileSync(layout.settingsFile);
          const oldHealth = await client.health();
          const browser = await client.redeemWebBootstrap(
            (await client.createWebBootstrap()).token,
          );
          const journal = createSashUpgradeJournal(installation, "2.0.0");
          const result = await new SashUpgradeTransaction(journal, {
            stagePackage: async ({ prefix, transactionId }) =>
              install(upgradeTransactionPaths(prefix, transactionId).stage, "2.0.0", badDaemon),
          }).run({
            name: "@astralyn/sash",
            version: "2.0.0",
            nodeRange: ">=24",
            upgradeProtocol: 1,
            tarball: "https://registry.npmjs.org/@astralyn/sash/-/sash-2.0.0.tgz",
            integrity: { algorithm: "sha512", digest: "0".repeat(128) },
          });
          assert.equal(result.outcome, badDaemon ? "failed" : "upgraded", result.error);
          assert.equal(result.recoveryRequired, false, result.error);
          assert.deepEqual(fs.readFileSync(layout.settingsFile), saved);
          assert.deepEqual(fs.readFileSync(layout.configFile), applied);
          assert.equal(crypto.hash("sha256", fs.readFileSync(layout.coreExe)), binarySha256);
          assert.deepEqual(await controller.runtimeState(), runtime);
          const status = await client.status(true);
          assert.equal(status.core.running, true);
          assert.equal(status.core.healthy, true);
          assert.equal(status.configuration.pending, true);
          assert.equal(status.configuration.appliedSettings?.mixedPort, mixedPort);
          assert.equal(status.settings.mixedPort, pendingPort);
          assert.equal(status.systemProxy.applied, false);
          const health = await client.health();
          assert.equal(health.version, badDaemon ? "1.0.0" : "2.0.0");
          assert.notEqual(health.token, oldHealth.token);
          const continued = await client.continueWebSession(browser);
          assert.equal(continued.daemonToken, health.token);
          assert.notEqual(continued.token, browser.token);
        } finally {
          const authorization = readUpgradeAuthorization(installation.id);
          const record = listInstallationInstances(installation.id, packageRoot).find((record) =>
            isProcessAlive(record.pid),
          );
          if (record && authorization) {
            const access = {
              transactionId: authorization.transactionId,
              installationId: authorization.installationId,
              grant: authorization.grant,
            };
            const status = await client.upgradeRuntime("status", access);
            if (status.phase !== "none" && status.phase !== "committed") {
              await client.upgradeRuntimeAction("stop", access);
              const deadline = Date.now() + 10_000;
              while (isProcessAlive(record.pid) && Date.now() < deadline)
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
          }
          assert.equal(await stopDaemonFromCli({ layout, settings }), true);
          assert.equal(
            await new MihomoApi(settings.controller, settings.secret).isReachable(),
            false,
          );
        }
      });
    }
});
