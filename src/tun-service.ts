import type { TunStatusResponse } from "./contracts.js";
import type { HelperClient } from "./launcher/protocol.js";
import { readSashPackageInfo } from "./package-info.js";
import type { SashLayout } from "./paths.js";
import type { TunSettings } from "./tun-settings.js";

interface TunHelperInspection {
  installed: boolean | null;
  helperVersion?: string | null;
  needsReconsent?: boolean;
  coreSynced?: boolean | null;
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

/**
 * Inspection shells out (service queries, digests, --version), so status
 * callers that poll — the daemon event feed — share one result for
 * INSPECT_TTL_MS. Install/uninstall invalidates the cache immediately, and
 * interactive readers (CLI `tun status`) always inspect fresh.
 */
const INSPECT_TTL_MS = 30_000;

export class TunService {
  private inspectCache: { at: number; value: TunHelperInspection } | undefined;

  constructor(
    readonly platform: TunPlatform,
    private readonly layout: SashLayout,
  ) {}

  invalidateInspect(): void {
    this.inspectCache = undefined;
  }

  private async inspect(fresh: boolean): Promise<TunHelperInspection> {
    if (fresh) {
      return this.platform.inspect(this.layout).catch(() => ({ installed: null }));
    }
    if (this.inspectCache && Date.now() - this.inspectCache.at < INSPECT_TTL_MS) {
      return this.inspectCache.value;
    }
    const value = await this.platform.inspect(this.layout).catch(() => ({ installed: null }));
    this.inspectCache = { at: Date.now(), value };
    return value;
  }

  async status(
    desired: boolean,
    applied: TunSettings | undefined,
    options: { fresh?: boolean } = {},
  ): Promise<TunStatusResponse> {
    const privilege = await this.inspect(options.fresh === true);
    const needsReconsent = helperNeedsReconsent(privilege);
    return {
      supported: this.platform.supported,
      desired,
      applied: applied?.enable ?? false,
      privilege: {
        mode: "helper",
        installed: privilege.installed,
        needsReconsent,
        version: privilege.helperVersion ?? null,
        coreSynced: privilege.coreSynced ?? null,
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
    this.invalidateInspect();
  }
}
