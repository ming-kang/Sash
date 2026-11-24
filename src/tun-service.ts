import type { TunStatusResponse } from "./contracts.js";
import type { HelperClient } from "./launcher/protocol.js";
import { readSashPackageInfo } from "./package-info.js";
import type { SashLayout } from "./paths.js";
import type { TunSettings } from "./tun-settings.js";

interface TunHelperInspection {
  installed: boolean | null;
  helperVersion?: string | null;
  needsReconsent?: boolean;
}

function helperNeedsReconsent(status: TunHelperInspection): boolean {
  return (
    status.installed === true &&
    (status.needsReconsent === true ||
      (status.helperVersion !== undefined &&
        status.helperVersion !== readSashPackageInfo().version))
  );
}

export interface TunPlatform {
  readonly supported: boolean;
  inspect(layout: SashLayout): Promise<TunHelperInspection & { installed: boolean }>;
  install(layout: SashLayout): Promise<void>;
  uninstall(layout: SashLayout): Promise<void>;
  connect(layout: SashLayout): HelperClient;
}

export function unsupportedTunPlatform(): TunPlatform {
  function unavailable(): never {
    throw new Error("TUN helper integration is not available on this platform yet");
  }
  return {
    supported: false,
    inspect: async () => ({ installed: false }),
    install: async () => unavailable(),
    uninstall: async () => unavailable(),
    connect: unavailable,
  };
}

export class TunService {
  constructor(
    readonly platform: TunPlatform,
    private readonly layout: SashLayout,
  ) {}

  async status(desired: boolean, applied: TunSettings | undefined): Promise<TunStatusResponse> {
    const privilege = await this.platform.inspect(this.layout).catch(() => ({
      installed: null,
    }));
    const needsReconsent = helperNeedsReconsent(privilege);
    return {
      supported: this.platform.supported,
      desired,
      applied: applied?.enable ?? false,
      privilege: {
        mode: "helper",
        installed: privilege.installed,
        needsReconsent,
      },
    };
  }

  async checkReady(): Promise<void> {
    if (!this.platform.supported) throw new Error("TUN helper integration is unavailable");
    const status = await this.platform.inspect(this.layout);
    if (!status.installed) throw new Error("Install the TUN helper before Apply");
    if (helperNeedsReconsent(status))
      throw new Error("TUN helper needs re-consent; run sash tun helper install");
  }

  async setInstalled(installed: boolean): Promise<void> {
    if (installed) await this.platform.install(this.layout);
    else await this.platform.uninstall(this.layout);
  }
}
