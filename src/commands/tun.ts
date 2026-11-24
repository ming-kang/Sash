import { commandOutput } from "../cli-output.js";
import { ensureDaemonSession, resolveDaemonSession } from "../daemon-session.js";
import { log } from "../log.js";
import { createTunPlatform } from "../tun-platform/index.js";
import { describeTunHelper, TunService } from "../tun-service.js";
import { runtimeContext } from "./shared.js";

export type TunAction = "on" | "off" | "status" | "helper";
export type TunHelperAction = "install" | "uninstall" | "status";

export async function runTun(
  action: TunAction = "status",
  helperAction: TunHelperAction | undefined,
  options: { json?: boolean },
): Promise<void> {
  if (helperAction && action !== "helper")
    throw new Error("Helper actions require sash tun helper");
  await commandOutput(
    options.json,
    async () => {
      const context = runtimeContext();
      if (
        action === "status" ||
        (action === "helper" && (!helperAction || helperAction === "status"))
      ) {
        const owner = await resolveDaemonSession(context);
        if (owner.kind === "daemon") return owner.client.tunStatus();
        if (owner.kind === "unhealthy") process.exitCode = 2;
        return new TunService(createTunPlatform(), context.layout).status(
          context.settings.tun.enable,
          undefined,
          { fresh: true },
        );
      }
      const { client } = await ensureDaemonSession(context);
      if (action === "helper") return client.setTunHelper(helperAction === "install");
      const status = await client.status();
      await client.patchSettings({
        tun: { enable: action === "on" },
        expectedRevision: status.revisions.state,
      });
      return client.tunStatus();
    },
    (status) => {
      const helper: [string, string] = ["TUN Helper", describeTunHelper(status)];
      log.table(
        action === "helper"
          ? [helper]
          : [
              ["TUN Setting", status.desired ? "On" : "Off"],
              ["TUN Applied", status.applied ? "On" : "Off"],
              helper,
            ],
      );
      if (status.supported && status.privilege.state !== "ready")
        log.info(
          status.privilege.mechanism === "service"
            ? "Run sash tun helper install to install the TUN service (administrator approval)."
            : "Run sash tun helper install to authorize the Core (administrator approval); a Core update clears this.",
        );
      if (status.applied) log.info("Sash does not check OS routes or DNS interception.");
      if (status.desired !== status.applied) log.info("Run sash restart to Apply the TUN setting.");
    },
  );
}
