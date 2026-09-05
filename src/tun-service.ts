import type { DaemonStatus, SettingsWriteResult } from "./contracts.js";
import { log } from "./log.js";
import type { RuntimeContext } from "./offline-mutation.js";
import { type CommandRuntimeOwner, resolveRuntimeOwner } from "./runtime-owner.js";
import type { SashClient } from "./sash-client.js";
import { tunPrivilegeGuidance } from "./tun-guidance.js";

type TunRuntimeOwner =
  | Exclude<CommandRuntimeOwner, { kind: "daemon" }>
  | { kind: "daemon"; client: Pick<SashClient, "patchSettings" | "status"> };

export interface TunServiceDeps {
  resolveRuntimeOwner?: (ctx: RuntimeContext) => Promise<TunRuntimeOwner>;
}

/** Mutate only through the verified daemon; observation cannot undo committed success. */
export async function setTun(
  ctx: RuntimeContext,
  target: boolean,
  deps: TunServiceDeps = {},
): Promise<void> {
  const owner = await (deps.resolveRuntimeOwner ?? resolveRuntimeOwner)(ctx);
  if (owner.kind === "offline") {
    throw new Error(
      `Sash is not running. Run "sash start" first, then retry "sash tun ${target ? "on" : "off"}".`,
    );
  }
  if (owner.kind === "unhealthy") {
    throw new Error(
      "The Sash daemon is starting or unresponsive; refusing to change TUN or start a competing daemon. Inspect sash status and sash logs --daemon.",
    );
  }

  // Preserve typed API failures (including activation rollback) without translation.
  const result: SettingsWriteResult = await owner.client.patchSettings({ tun: target });
  const desired = result.settings.tun;
  log.ok(`TUN desired setting saved: ${desired ? "on" : "off"}`);

  let status: DaemonStatus;
  try {
    status = await owner.client.status(true);
  } catch {
    log.warn(
      'TUN runtime state could not be observed; the desired setting is saved. Run "sash status" to check later.',
    );
    return;
  }

  if (!status.core.running) {
    log.info(
      'Core is stopped; the saved TUN setting is pending the next Core start. Run "sash start" when ready; this command did not start Core.',
    );
  } else if (!status.core.healthy) {
    log.warn(
      `${status.core.healthy === false ? "Core is unhealthy" : "Core health is unverified"}; TUN runtime state cannot be confirmed. The desired setting is saved; inspect "sash status" and "sash logs --errors".`,
    );
  } else if (status.core.tunActive === true) {
    if (desired) log.ok("TUN runtime is active; network connectivity is not verified.");
    else
      log.warn(
        'TUN remains active unexpectedly despite the saved off setting; inspect "sash status" and "sash logs --errors".',
      );
  } else if (status.core.tunActive === false) {
    if (desired) {
      log.warn(
        `TUN is inactive despite the saved on setting. ${tunPrivilegeGuidance("runtime-inactive", { root: ctx.layout.root })}`,
      );
    } else {
      log.ok("TUN runtime is inactive.");
    }
  } else {
    log.warn(
      'TUN runtime state is unverified; the desired setting is saved. Inspect "sash status" and "sash logs --errors".',
    );
  }
}
