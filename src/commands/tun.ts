import { commandOutput } from "../cli-output.js";
import { ensureDaemonSession, resolveDaemonSession } from "../daemon-session.js";
import { log } from "../log.js";
import { createTunPlatform } from "../tun-platform/index.js";
import { TunService } from "../tun-service.js";
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
      log.table([
        ["TUN Setting", status.desired ? "On" : "Off"],
        ["TUN Applied", status.applied ? "On" : "Off"],
        [
          "TUN Helper",
          !status.supported
            ? "Not Supported"
            : status.privilege.installed === null
              ? "Unknown"
              : status.privilege.installed
                ? status.privilege.needsReconsent
                  ? "Needs Re-consent (run sash tun helper install)"
                  : "Installed"
                : "Not Installed",
        ],
      ]);
      if (status.applied) log.info("Sash does not check OS routes or DNS interception.");
      if (status.desired !== status.applied) log.info("Run sash restart to Apply the TUN setting.");
    },
  );
}
