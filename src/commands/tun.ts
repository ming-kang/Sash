import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { commandOutput } from "../cli-output.js";
import {
  parseTunHelperAuth,
  type TunApplyState,
  type TunHelperStatus,
  tunApplyState,
} from "../contracts.js";
import { ensureDaemonSession, resolveDaemonSession } from "../daemon-session.js";
import { log } from "../log.js";
import type { SashClient } from "../sash-client.js";
import { TUN_GUARD_PATH } from "../tun-guard.js";
import { createTunPlatform } from "../tun-platform/index.js";
import { describeTunHelper, TunService } from "../tun-service.js";
import { runtimeContext } from "./shared.js";

export type TunAction = "on" | "off" | "status" | "helper";
export type TunHelperAction = "install" | "uninstall" | "status";

export interface TunReport extends TunApplyState {
  helper: TunHelperStatus;
}

async function daemonReport(client: SashClient, helper?: TunHelperStatus): Promise<TunReport> {
  const [status, current] = await Promise.all([client.status(), helper ?? client.tunHelper()]);
  return { ...tunApplyState(status), helper: current };
}

export type TunGuardAction = "setup" | "teardown" | "status";
export type TunGuardProcessLauncher = (cmd: string, args: string[]) => Promise<number>;

function spawnInherited(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

export interface TunGuardCommandDeps {
  platform?: NodeJS.Platform | string;
  asRoot?: boolean;
  scriptPath?: string;
  launch?: TunGuardProcessLauncher;
}

/** Hidden recovery entry point: unlike the normal TUN commands it does not need the daemon. */
export async function runTunGuard(
  verb: TunGuardAction = "status",
  deps: TunGuardCommandDeps = {},
): Promise<void> {
  if ((deps.platform ?? process.platform) !== "darwin")
    throw new Error("sash tun guard is only available on macOS");
  const scriptPath = deps.scriptPath ?? TUN_GUARD_PATH;
  if (!existsSync(scriptPath))
    throw new Error("the TUN guard is not installed; run sash tun helper install first");
  const asRoot = deps.asRoot ?? process.geteuid?.() === 0;
  const launch = deps.launch ?? spawnInherited;
  const code = asRoot
    ? await launch(scriptPath, [verb])
    : await launch("/usr/bin/sudo", ["-n", scriptPath, verb]);
  if (code !== 0) process.exitCode = code;
}

export async function runTun(
  action: TunAction = "status",
  helperAction: TunHelperAction | undefined,
  options: { json?: boolean },
): Promise<void> {
  if (helperAction && action !== "helper")
    throw new Error("Helper actions require sash tun helper");
  await commandOutput(
    options.json,
    async (): Promise<TunReport> => {
      const context = runtimeContext();
      if (
        action === "status" ||
        (action === "helper" && (!helperAction || helperAction === "status"))
      ) {
        const owner = await resolveDaemonSession(context);
        if (owner.kind === "daemon") return daemonReport(owner.client);
        if (owner.kind === "unhealthy") process.exitCode = 2;
        const desired = context.settings.tun.enable;
        return {
          desired,
          applied: false,
          pending: desired,
          helper: await new TunService(createTunPlatform(), context.layout).helperStatus({
            fresh: true,
          }),
        };
      }
      const { client } = await ensureDaemonSession(context);
      if (action === "helper") {
        const helperAuth = parseTunHelperAuth(process.env.SASH_TUN_HELPER_AUTH?.trim());
        return daemonReport(
          client,
          await client.setTunHelper(helperAction === "install", {
            ...(helperAuth ? { helperAuth } : {}),
          }),
        );
      }
      const status = await client.status();
      await client.patchSettings({
        tun: { enable: action === "on" },
        expectedRevision: status.revisions.state,
      });
      return daemonReport(client);
    },
    ({ desired, applied, pending, helper }) => {
      const helperRow: [string, string] = ["TUN Helper", describeTunHelper(helper)];
      log.table(
        action === "helper"
          ? [helperRow]
          : [
              ["TUN Setting", desired ? "On" : "Off"],
              ["TUN Applied", applied ? "On" : "Off"],
              helperRow,
            ],
      );
      if (helper.state !== "unsupported" && helper.state !== "ready")
        log.info(
          helper.mechanism === "service"
            ? "Run sash tun helper install to install the TUN service (administrator approval)."
            : "Run sash tun helper install to authorize the Core (administrator approval); a Core update clears this.",
        );
      if (applied) log.info("Sash does not check OS routes or DNS interception.");
      if (pending) log.info("Run sash restart to Apply the TUN settings.");
    },
  );
}
