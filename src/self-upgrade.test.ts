import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { MockAgent } from "undici";
import { directDispatcherForLoopback, proxyAwareDispatcher } from "./http.js";
import { inspectInstallation, type NpmInstallation, npmPackageRoot } from "./sash-installation.js";
import {
  executeSashUpgrade,
  inspectSashUpgrade,
  resolveNpmCli,
  resolveSashUpgradeTarget,
} from "./self-upgrade.js";

const SASH_PACKAGE_NAME = "@astralyn/sash";
const REGISTRY = "https://registry.npmjs.org";

function tempRoot(t: TestContext, label: string): string {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, label));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), parent);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function writeSashPackage(packageRoot: string, version: string): string {
  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: SASH_PACKAGE_NAME,
      version,
      type: "module",
      bin: { sash: "dist/cli.js" },
      engines: { node: ">=24" },
    }),
  );
  fs.writeFileSync(path.join(packageRoot, "dist", "cli.js"), `// Sash ${version}\n`);
  return packageRoot;
}

function packageManifest(version: string, nodeRange = ">=24") {
  return {
    name: SASH_PACKAGE_NAME,
    version,
    engines: { node: nodeRange },
    bin: { sash: "dist/cli.js" },
  };
}

function interceptRegistry(t: TestContext): MockAgent {
  const agent = new MockAgent();
  agent.disableNetConnect();
  t.mock.method(proxyAwareDispatcher(), "dispatch", agent.dispatch.bind(agent));
  return agent;
}

function snapshot(root: string): string[] {
  return fs.readdirSync(root, { recursive: true, encoding: "utf8" }).sort();
}

describe("Sash upgrade inspection", () => {
  it("resolves an existing npm-cli.js and fails clearly when npm is missing", (t) => {
    const root = tempRoot(t, "sash-npm-cli-");
    const nodeDir = path.join(root, "node");
    const local = path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, "// npm CLI\n");
    assert.equal(resolveNpmCli(path.join(nodeDir, "node"), { PATH: "" }), local);

    const bare = path.join(root, "bare node");
    const execPath = path.join(root, "global npm", "npm-cli.js");
    fs.mkdirSync(path.dirname(execPath), { recursive: true });
    fs.writeFileSync(execPath, "// npm CLI\n");
    assert.equal(
      resolveNpmCli(path.join(bare, "node"), { PATH: "", npm_execpath: execPath }),
      execPath,
    );

    for (const env of [
      { PATH: "" },
      { PATH: "", npm_execpath: "relative/npm-cli.js" },
      { PATH: "", npm_execpath: path.join(root, "missing", "npm-cli.js") },
    ]) {
      assert.throws(() => resolveNpmCli(path.join(bare, "node"), env), /Cannot find the npm CLI/);
    }
  });

  it("reports a non-npm-global package root with a reason and never resolves a target", async (t) => {
    const root = tempRoot(t, "sash-upgrade-unsupported-");
    const packageRoot = writeSashPackage(path.join(root, "checkout"), "1.0.0");
    const agent = interceptRegistry(t);
    const before = snapshot(root);
    try {
      const { report, installation, target } = await inspectSashUpgrade(undefined, {
        packageRoot,
        nodeVersion: "v24.1.0",
      });
      assert.equal(installation.kind, "source");
      assert.equal(installation.reason, report.reason);
      assert.equal(target, undefined);
      assert.equal(report.current, "1.0.0");
      assert.equal(report.target, null);
      assert.equal(report.available, false);
      assert.equal(report.compatible, false);
      assert.equal(report.supported, false);
      assert.equal(report.installation, "source");
      assert.equal(report.node, "v24.1.0");
      assert.equal(report.prefix, undefined);
      assert.match(report.reason ?? "", /local installation/);
      assert.deepEqual(snapshot(root), before);
      agent.assertNoPendingInterceptors();
    } finally {
      await agent.close();
    }
  });

  for (const scenario of [
    { target: "2.0.0", nodeRange: ">=24", available: true, compatible: true },
    { target: "1.0.0", nodeRange: ">=24", available: false, compatible: true },
    { target: "0.9.0", explicit: "0.9.0", nodeRange: ">=24", available: true, compatible: true },
    { target: "2.0.0", nodeRange: ">=100", available: true, compatible: false },
  ]) {
    it(`reports availability and compatibility for an npm global install: ${JSON.stringify(scenario)}`, async (t) => {
      const root = tempRoot(t, "sash-upgrade-check-");
      const prefix = path.join(root, "npm prefix 中文");
      const packageRoot = writeSashPackage(npmPackageRoot(prefix), "1.0.0");
      const agent = interceptRegistry(t);
      agent
        .get(REGISTRY)
        .intercept({
          path: `/${encodeURIComponent(SASH_PACKAGE_NAME)}/${scenario.explicit ?? "latest"}`,
        })
        .reply(200, packageManifest(scenario.target, scenario.nodeRange));
      const before = snapshot(root);
      try {
        const { report, target } = await inspectSashUpgrade(scenario.explicit, {
          packageRoot,
          nodeVersion: "v24.5.0",
        });
        assert.deepEqual(target, {
          name: SASH_PACKAGE_NAME,
          version: scenario.target,
          nodeRange: scenario.nodeRange,
        });
        assert.equal(report.current, "1.0.0");
        assert.equal(report.target, scenario.target);
        assert.equal(report.available, scenario.available);
        assert.equal(report.compatible, scenario.compatible);
        assert.equal(report.supported, true);
        assert.equal(report.installation, "npm-global");
        assert.equal(report.prefix, fs.realpathSync.native(prefix));
        assert.equal(report.node, "v24.5.0");
        assert.equal(report.requiredNode, scenario.nodeRange);
        assert.equal(
          report.reason,
          scenario.compatible
            ? undefined
            : `Sash ${scenario.target} requires Node ${scenario.nodeRange}`,
        );
        assert.deepEqual(snapshot(root), before);
        agent.assertNoPendingInterceptors();
      } finally {
        await agent.close();
      }
    });
  }

  it("keeps a failed registry lookup read-only", async (t) => {
    const root = tempRoot(t, "sash-upgrade-failure-");
    const packageRoot = writeSashPackage(npmPackageRoot(path.join(root, "prefix")), "1.0.0");
    const agent = interceptRegistry(t);
    agent
      .get(REGISTRY)
      .intercept({ path: `/${encodeURIComponent(SASH_PACKAGE_NAME)}/latest` })
      .reply(404, "not available");
    const before = snapshot(root);
    try {
      await assert.rejects(
        inspectSashUpgrade(undefined, { packageRoot, nodeVersion: "v24.5.0" }),
        /HTTP 404/,
      );
      assert.deepEqual(snapshot(root), before);
      agent.assertNoPendingInterceptors();
    } finally {
      await agent.close();
    }
  });

  it("parses a published manifest and rejects a mismatched or malformed document", async (t) => {
    const agent = interceptRegistry(t);
    try {
      agent
        .get(REGISTRY)
        .intercept({ path: `/${encodeURIComponent(SASH_PACKAGE_NAME)}/latest` })
        .reply(200, packageManifest("2.3.4"));
      assert.deepEqual(await resolveSashUpgradeTarget(), {
        name: SASH_PACKAGE_NAME,
        version: "2.3.4",
        nodeRange: ">=24",
      });
      agent.assertNoPendingInterceptors();

      agent
        .get(REGISTRY)
        .intercept({ path: `/${encodeURIComponent(SASH_PACKAGE_NAME)}/1.2.3` })
        .reply(200, packageManifest("1.2.4"));
      await assert.rejects(resolveSashUpgradeTarget("1.2.3"), /different Sash version/);
      agent.assertNoPendingInterceptors();

      agent
        .get(REGISTRY)
        .intercept({ path: `/${encodeURIComponent(SASH_PACKAGE_NAME)}/latest` })
        .reply(200, { name: "not-sash", version: "2.3.4" });
      await assert.rejects(resolveSashUpgradeTarget(), /Expected package @astralyn\/sash/);
      agent.assertNoPendingInterceptors();
    } finally {
      await agent.close();
    }
  });

  it("falls back to direct request when loopback proxy is refused", async (t) => {
    const proxyError = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:7890"), {
      code: "ECONNREFUSED",
      address: "127.0.0.1",
      port: 7890,
    });
    t.mock.method(proxyAwareDispatcher(), "dispatch", () => {
      throw proxyError;
    });

    const directAgent = new MockAgent();
    directAgent.disableNetConnect();
    t.mock.method(
      directDispatcherForLoopback(),
      "dispatch",
      directAgent.dispatch.bind(directAgent),
    );

    directAgent
      .get(REGISTRY)
      .intercept({ path: `/${encodeURIComponent(SASH_PACKAGE_NAME)}/latest` })
      .reply(200, packageManifest("2.3.4"));

    const target = await resolveSashUpgradeTarget();
    assert.equal(target.version, "2.3.4");
    directAgent.assertNoPendingInterceptors();
    await directAgent.close();
  });
});

describe("Sash upgrade sequence", () => {
  function installation(t: TestContext): NpmInstallation {
    const prefix = tempRoot(t, "sash-upgrade-order-");
    const packageRoot = writeSashPackage(npmPackageRoot(prefix), "0.1.7");
    return inspectInstallation({
      packageRoot,
      nodePath: process.execPath,
      platform: "win32",
    }) as NpmInstallation;
  }

  /** Records the order of the steps that must not be reordered. */
  function recorder(running: boolean, calls: string[], options: { coreRunning?: boolean } = {}) {
    return {
      install: async (_installation: NpmInstallation, version: string) => {
        calls.push(`install ${version}`);
      },
      resolveOwner: async () =>
        ({
          kind: running ? "daemon" : "offline",
          client: {
            status: async () => ({
              core: { running: options.coreRunning ?? false },
            }),
          },
        }) as never,
      stop: async () => {
        calls.push("stop");
        return { wasRunning: true };
      },
      start: async () => {
        calls.push("start");
        return {
          client: {
            startCore: async () => {
              calls.push("startCore");
            },
          },
        } as never;
      },
      startCore: async () => {
        calls.push("startCore");
      },
    };
  }

  const target = {
    name: SASH_PACKAGE_NAME as typeof SASH_PACKAGE_NAME,
    version: "0.2.0",
    nodeRange: ">=24",
  };

  it("installs before stopping anything, then restarts onto the new version", async (t) => {
    const calls: string[] = [];
    const outcome = await executeSashUpgrade(installation(t), target, {}, recorder(true, calls));
    assert.deepEqual(calls, ["install 0.2.0", "stop", "start"]);
    assert.equal(outcome.restarted, true);
    assert.equal(outcome.version, "0.2.0");
  });

  it("restarts the daemon and restores the running Core when Core was active before upgrade", async (t) => {
    const calls: string[] = [];
    const outcome = await executeSashUpgrade(
      installation(t),
      target,
      {},
      recorder(true, calls, { coreRunning: true }),
    );
    assert.deepEqual(calls, ["install 0.2.0", "stop", "start", "startCore"]);
    assert.equal(outcome.restarted, true);
    assert.equal(outcome.version, "0.2.0");
  });

  it("restarts the daemon without starting Core when Core was stopped before upgrade", async (t) => {
    const calls: string[] = [];
    const outcome = await executeSashUpgrade(
      installation(t),
      target,
      {},
      recorder(true, calls, { coreRunning: false }),
    );
    assert.deepEqual(calls, ["install 0.2.0", "stop", "start"]);
    assert.equal(outcome.restarted, true);
    assert.equal(outcome.version, "0.2.0");
  });

  it("leaves the running daemon alone with --no-restart", async (t) => {
    const calls: string[] = [];
    const outcome = await executeSashUpgrade(
      installation(t),
      target,
      { restart: false },
      recorder(true, calls),
    );
    assert.deepEqual(calls, ["install 0.2.0"]);
    assert.equal(outcome.restarted, false);
  });

  it("only installs when no daemon is running", async (t) => {
    const calls: string[] = [];
    const outcome = await executeSashUpgrade(installation(t), target, {}, recorder(false, calls));
    assert.deepEqual(calls, ["install 0.2.0"]);
    assert.equal(outcome.restarted, false);
  });
});
