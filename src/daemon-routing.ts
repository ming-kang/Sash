export interface ParsedDaemonRequestTarget {
  /** WHATWG-canonical pathname; percent-encoded slash remains encoded. */
  pathname: string;
  /** Pathname used for route matching, with trailing slashes removed. */
  routePathname: string;
  search: string;
  searchParams: URLSearchParams;
}

function normalizeRoutePathname(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

/**
 * Parse only HTTP origin-form request targets. Absolute-, authority-,
 * asterisk-, network-path and cross-authority backslash forms are rejected so
 * authentication and forwarding always consume one canonical pathname.
 */
export function parseDaemonRequestTarget(
  rawTarget: string,
  hostHeader: string,
): ParsedDaemonRequestTarget {
  if (!rawTarget.startsWith("/") || rawTarget.startsWith("//")) {
    throw new Error("Unsupported HTTP request-target form");
  }
  const base = new URL(`http://${hostHeader}`);
  const url = new URL(rawTarget, base);
  if (url.origin !== base.origin || url.hash) {
    throw new Error("Invalid HTTP origin-form request target");
  }
  return {
    pathname: url.pathname,
    routePathname: normalizeRoutePathname(url.pathname),
    search: url.search,
    searchParams: url.searchParams,
  };
}

export type FixedHttpRouteKind =
  | "health"
  | "rootRedirect"
  | "uiRedirect"
  | "staticUi"
  | "status"
  | "proxyStatus"
  | "proxyEnable"
  | "proxyDisable"
  | "profiles"
  | "settingsRead"
  | "settingsUpdate"
  | "shutdown"
  | "maintenanceShutdown"
  | "coreStart"
  | "coreStop"
  | "coreRestart"
  | "coreConfigReload";

export type DaemonHttpRoute =
  | { kind: FixedHttpRouteKind }
  | { kind: "coreGateway"; target: string }
  | { kind: "methodNotAllowed"; allow: readonly string[] }
  | { kind: "notFound" };

interface FixedRouteDefinition {
  kind: FixedHttpRouteKind;
  methods: readonly string[];
  paths: readonly string[];
}

const FIXED_HTTP_ROUTES: readonly FixedRouteDefinition[] = [
  { kind: "health", methods: ["GET"], paths: ["/sash/health", "/health"] },
  { kind: "status", methods: ["GET"], paths: ["/sash/status", "/status"] },
  { kind: "proxyStatus", methods: ["GET"], paths: ["/sash/proxy", "/proxy"] },
  {
    kind: "proxyEnable",
    methods: ["POST"],
    paths: ["/sash/proxy/enable", "/proxy/enable"],
  },
  {
    kind: "proxyDisable",
    methods: ["POST"],
    paths: ["/sash/proxy/disable", "/proxy/disable"],
  },
  { kind: "settingsRead", methods: ["GET"], paths: ["/sash/settings"] },
  {
    kind: "settingsUpdate",
    methods: ["PATCH"],
    paths: ["/sash/settings", "/settings"],
  },
  { kind: "maintenanceShutdown", methods: ["POST"], paths: ["/sash/maintenance/shutdown"] },
  { kind: "shutdown", methods: ["POST"], paths: ["/sash/shutdown", "/shutdown"] },
  { kind: "coreStart", methods: ["POST"], paths: ["/core/start"] },
  { kind: "coreStop", methods: ["POST"], paths: ["/core/stop"] },
  { kind: "coreRestart", methods: ["POST"], paths: ["/core/restart"] },
  {
    kind: "coreConfigReload",
    methods: ["POST"],
    paths: ["/core/config/reload", "/config/reload"],
  },
];

const STANDARD_CORE_PREFIXES = [
  "/proxies",
  "/rules",
  "/connections",
  "/providers",
  "/dns",
] as const;

const METHOD_ORDER = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

function matchesPathPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function methodOrder(method: string): number {
  const index = METHOD_ORDER.indexOf(method as (typeof METHOD_ORDER)[number]);
  return index < 0 ? METHOD_ORDER.length : index;
}

function methodMatch(method: string, candidates: readonly FixedRouteDefinition[]): DaemonHttpRoute {
  const exact = candidates.find((candidate) => candidate.methods.includes(method));
  if (exact) return { kind: exact.kind };
  const allow = [...new Set(candidates.flatMap((candidate) => candidate.methods))].sort(
    (left, right) => methodOrder(left) - methodOrder(right),
  );
  return { kind: "methodNotAllowed", allow };
}

function coreApiTarget(target: ParsedDaemonRequestTarget): string | undefined {
  const prefix = "/core/api";
  if (!matchesPathPrefix(target.routePathname, prefix)) return undefined;
  const suffix = target.pathname.slice(prefix.length);
  const upstreamPath = suffix ? `/${suffix.replace(/^\/+/, "")}` : "/";
  return `${upstreamPath}${target.search}`;
}

function standardCoreTarget(target: ParsedDaemonRequestTarget): string | undefined {
  if (target.routePathname === "/version") return `${target.pathname}${target.search}`;
  if (STANDARD_CORE_PREFIXES.some((prefix) => matchesPathPrefix(target.routePathname, prefix))) {
    return `${target.pathname}${target.search}`;
  }
  return undefined;
}

function profileMethods(pathname: string): readonly string[] | undefined {
  if (pathname === "/sash/profiles") return ["GET", "POST"];
  if (pathname === "/sash/profiles/import") return ["POST"];
  if (pathname === "/sash/profiles/active") return ["PUT"];
  if (pathname === "/sash/profiles/update-all") return ["POST"];
  if (/^\/sash\/profiles\/[0-9]+\/update$/.test(pathname)) return ["POST"];
  if (/^\/sash\/profiles\/[0-9]+\/content$/.test(pathname)) return ["GET", "PUT"];
  if (/^\/sash\/profiles\/[0-9]+$/.test(pathname)) return ["DELETE"];
  return undefined;
}

/** Match one canonical HTTP route, including method-mismatch metadata. */
export function matchHttpRoute(method: string, target: ParsedDaemonRequestTarget): DaemonHttpRoute {
  const normalizedMethod = method.toUpperCase();
  const pathname = target.routePathname;

  const coreTarget = coreApiTarget(target) ?? standardCoreTarget(target);
  if (coreTarget !== undefined) return { kind: "coreGateway", target: coreTarget };

  if (pathname === "/") {
    return ["GET", "HEAD"].includes(normalizedMethod)
      ? { kind: "rootRedirect" }
      : { kind: "methodNotAllowed", allow: ["GET", "HEAD"] };
  }

  if (pathname === "/ui" || pathname.startsWith("/ui/")) {
    if (!["GET", "HEAD"].includes(normalizedMethod)) {
      return { kind: "methodNotAllowed", allow: ["GET", "HEAD"] };
    }
    return {
      kind: target.pathname === "/ui" ? "uiRedirect" : "staticUi",
    };
  }

  const allowedProfileMethods = profileMethods(pathname);
  if (allowedProfileMethods) {
    return allowedProfileMethods.includes(normalizedMethod)
      ? { kind: "profiles" }
      : { kind: "methodNotAllowed", allow: allowedProfileMethods };
  }

  const fixedCandidates = FIXED_HTTP_ROUTES.filter((candidate) =>
    candidate.paths.some((path) => path === pathname),
  );
  if (fixedCandidates.length > 0) return methodMatch(normalizedMethod, fixedCandidates);

  return { kind: "notFound" };
}

export type DaemonWebSocketRoute =
  | { kind: "coreGateway"; target: string }
  | { kind: "methodNotAllowed"; allow: readonly ["GET"] }
  | { kind: "notFound" };

function webSocketTarget(target: ParsedDaemonRequestTarget): string | undefined {
  const namespaced = coreApiTarget(target);
  if (namespaced !== undefined) return namespaced;
  if (target.routePathname === "/traffic" || target.routePathname === "/logs") {
    return `${target.pathname}${target.search}`;
  }
  return undefined;
}

/** Match only the explicitly supported Core WebSocket stream routes. */
export function matchWebSocketRoute(
  method: string,
  target: ParsedDaemonRequestTarget,
): DaemonWebSocketRoute {
  const upstreamTarget = webSocketTarget(target);
  if (upstreamTarget === undefined) return { kind: "notFound" };
  if (method.toUpperCase() !== "GET") return { kind: "methodNotAllowed", allow: ["GET"] };
  return { kind: "coreGateway", target: upstreamTarget };
}
