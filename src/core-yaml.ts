import YAML from "yaml";

/** Keep subscription, local-source and runtime-handoff alias expansion equally bounded. */
export function parseCoreYaml(text: string): unknown {
  return YAML.parse(text, { maxAliasCount: 50 });
}

const SHARE_LINK = /^(?:ss|ssr|vmess|vless|trojan|hysteria2?|hy2|tuic|socks5?):\/\//i;

function containsShareLinks(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  return lines.length > 0 && lines.every((line) => SHARE_LINK.test(line));
}

/** Detect common provider format mistakes without converting or printing subscription credentials. */
export function rejectShareLinkSubscription(text: string): void {
  let format = containsShareLinks(text) ? "share links" : "";
  if (!format) {
    const compact = text.replace(/\s/g, "").replaceAll("-", "+").replaceAll("_", "/");
    if (compact.length >= 12 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
      const decoded = Buffer.from(compact, "base64");
      if (
        decoded.toString("base64").replace(/=+$/, "") === compact.replace(/=+$/, "") &&
        containsShareLinks(decoded.toString("utf8"))
      )
        format = "base64-encoded share links";
    }
  }
  if (format)
    throw new Error(
      `Subscription contains ${format}. Request a core-format YAML subscription from the provider; Sash does not convert share-link subscriptions.`,
    );
}
