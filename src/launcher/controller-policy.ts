import { z } from "zod";
import { validateDelayTarget } from "../core-delay.js";

const port = z.number().int().min(0).max(65535).optional();
const flag = z.boolean().optional();
const runtimePatch = z.strictObject({
  mode: z.enum(["rule", "global", "direct"]).optional(),
  "log-level": z.enum(["silent", "error", "warning", "info", "debug"]).optional(),
  ipv6: flag,
  "allow-lan": flag,
  sniffing: flag,
  "tcp-concurrent": flag,
  "find-process-mode": z.enum(["always", "strict", "off"]).optional(),
  "bind-address": z.string().max(255).optional(),
  "interface-name": z.string().max(255).optional(),
  port,
  "mixed-port": port,
  "socks-port": port,
  "redir-port": port,
  "tproxy-port": port,
  // A partial TUN object defaults enable to false. Changes to the device or
  // routing settings must go through the helper's network ownership lifecycle.
  tun: z.strictObject({ enable: z.literal(true) }).optional(),
});

export function allowedControllerTarget(
  method: string,
  raw: string,
): { path: string; action: "proxy" | "select" | "patch" | "restart" } | undefined {
  if (!raw.startsWith("/") || raw.length > 8192 || /[#\\\p{Cc}]/u.test(raw)) return;
  const at = raw.indexOf("?");
  const pathname = at < 0 ? raw : raw.slice(0, at);
  const rawQuery = at < 0 ? "" : raw.slice(at + 1);
  let parts: string[];
  try {
    const trimmed = pathname.slice(1).replace(/\/$/, "");
    if (pathname.startsWith("//")) return;
    parts = trimmed
      ? trimmed.split("/").map((part) => {
          const decoded = decodeURIComponent(part);
          if (!decoded || decoded === "." || decoded === ".." || /[/%\\\p{Cc}]/u.test(decoded))
            throw new Error("Invalid controller path segment");
          return decoded;
        })
      : [];
  } catch {
    return;
  }
  const [first, second] = parts;
  const count = parts.length;
  if (first?.startsWith("upgrade") || first?.startsWith("debug")) return;
  const configs = first === "configs" && count === 1;
  if (
    (configs && method === "PUT") ||
    (first === "configs" && second === "geo" && method === "POST")
  )
    return;
  const query = new URLSearchParams(rawQuery);
  for (const [key, value] of query) {
    if (/path|file|directory|payload/i.test(key)) return;
    if (key === "url" && !/^https?:\/\//i.test(value)) return;
  }
  query.delete("token");
  if (first === "restart" && (method !== "POST" || count !== 1 || query.size)) return;
  const canonical = `/${parts.map(encodeURIComponent).join("/")}`;
  return {
    path: query.size ? `${canonical}?${query}` : canonical,
    action:
      first === "restart"
        ? "restart"
        : configs && method === "PATCH"
          ? "patch"
          : first === "proxies" && count === 2 && method === "PUT"
            ? "select"
            : "proxy",
  };
}

export function controllerPatchBody(text: string): string {
  return JSON.stringify(runtimePatch.parse(JSON.parse(text)));
}

export function controllerSelectBody(text: string): string {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || !("name" in value) || Object.keys(value).length !== 1)
    throw new Error("Expected a single proxy name");
  return JSON.stringify({ name: validateDelayTarget(value.name) });
}
