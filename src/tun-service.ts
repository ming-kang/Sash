import type {
  TunHelperAuth,
  TunPrivilegeMechanism,
  TunPrivilegeState,
  TunStatusResponse,
} from "./contracts.js";
import type { SashLayout } from "./paths.js";
import type { TunSettings } from "./tun-settings.js";

export interface TunPrivilege {
  state: TunPrivilegeState;
  detail?: string;
}

/**
 * A Core that runs outside Sash's process tree: a privileged host starts and
 * stops it, while Sash still reaches it through its ordinary controller.
 */
export interface HostedCore {
  start(): Promise<{ pid: number }>;
  stop(): Promise<void>;
  status(): Promise<{ running: boolean; pid: number | null }>;
}

export interface TunInstallOptions {
  /** Transport for any download the installation needs. */
  proxyUri?: string;
  /** Linux elevation mechanism explicitly chosen for this invocation. */
  helperAuth?: TunHelperAuth;
}

export interface TunPlatform {
  readonly mechanism: TunPrivilegeMechanism | null;
  inspect(layout: SashLayout): Promise<TunPrivilege>;
  install(layout: SashLayout, options?: TunInstallOptions): Promise<void>;
  uninstall(layout: SashLayout, options?: TunInstallOptions): Promise<void>;
  /**
   * Present when TUN Cores run under a privileged host. Without it the
   * privileged Core is launched like any other Core, as Sash's child.
   */
  host?(layout: SashLayout): HostedCore;
}

export function unsupportedTunPlatform(): TunPlatform {
  const unavailable = async (): Promise<never> => {
    throw new Error("TUN Mode is not available on this platform");
  };
  return {
    mechanism: null,
    inspect: async () => ({ state: "missing" }),
    install: unavailable,
    uninstall: unavailable,
  };
}

const MECHANISM_NAMES: Record<TunPrivilegeMechanism, string> = {
  service: "TUN service",
  setuid: "setuid Core",
  capabilities: "Core capabilities",
};

/** One-line helper state for the CLI and doctor. */
export function describeTunHelper(status: TunStatusResponse): string {
  if (!status.supported) return "Not available on this platform";
  const { mechanism, state, detail } = status.privilege;
  const reason = detail ? ` (${detail})` : "";
  switch (state) {
    case "ready":
      return mechanism ? `Ready (${MECHANISM_NAMES[mechanism]})` : "Ready";
    case "missing":
      return `Not installed${reason}`;
    case "stale":
      return `Needs reinstall${reason}`;
    case "unknown":
      return `Unknown${reason}`;
  }
}

/**
 * Inspection may shell out (service queries, getcap), so status callers that
 * poll — the daemon event feed — share one result for INSPECT_TTL_MS.
 * Install/uninstall invalidates the cache, and interactive readers always
 * inspect fresh.
 */
const INSPECT_TTL_MS = 30_000;

export class TunService {
  private inspectCache: { at: number; value: TunPrivilege } | undefined;

  constructor(
    readonly platform: TunPlatform,
    private readonly layout: SashLayout,
  ) {}

  get supported(): boolean {
    return this.platform.mechanism !== null;
  }

  invalidateInspect(): void {
    this.inspectCache = undefined;
  }

  private async inspect(fresh: boolean): Promise<TunPrivilege> {
    if (!fresh && this.inspectCache && Date.now() - this.inspectCache.at < INSPECT_TTL_MS) {
      return this.inspectCache.value;
    }
    const value = await this.platform.inspect(this.layout).catch(
      (error: unknown): TunPrivilege => ({
        state: "unknown",
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
    this.inspectCache = { at: Date.now(), value };
    return value;
  }

  async status(
    desired: boolean,
    applied: TunSettings | undefined,
    options: { fresh?: boolean } = {},
  ): Promise<TunStatusResponse> {
    const privilege = await this.inspect(options.fresh === true);
    return {
      supported: this.supported,
      desired,
      applied: applied?.enable ?? false,
      privilege: {
        mechanism: this.platform.mechanism,
        state: privilege.state,
        detail: privilege.detail ?? null,
      },
    };
  }

  async checkReady(): Promise<void> {
    if (!this.supported) throw new Error("TUN Mode is not available on this platform");
    const { state, detail } = await this.inspect(true);
    const reason = detail ? ` (${detail})` : "";
    switch (state) {
      case "ready":
        return;
      case "missing":
        throw new Error(`Install the TUN helper first: sash tun helper install${reason}`);
      case "stale":
        throw new Error(`Install the TUN helper again: sash tun helper install${reason}`);
      case "unknown":
        throw new Error(`Could not check the TUN helper${reason}`);
    }
  }

  async setInstalled(installed: boolean, options: TunInstallOptions = {}): Promise<void> {
    try {
      if (installed) await this.platform.install(this.layout, options);
      else await this.platform.uninstall(this.layout, options);
    } finally {
      this.invalidateInspect();
    }
  }
}
