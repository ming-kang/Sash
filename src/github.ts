import { downloadToFile, fetchWithRetry, USER_AGENT } from "./http.js";

/**
 * GitHub release access without hard dependency on the REST API:
 *
 * 1. Latest tag is resolved from the `releases/latest` 302 redirect, which does
 *    not consume the (60/h anonymous) REST rate limit and works through page
 *    mirrors such as ghfast.top.
 * 2. Asset listing uses the REST API when reachable (supports GITHUB_TOKEN /
 *    GH_TOKEN); otherwise falls back to synthesized candidate names since
 *    mihomo/metacubexd use deterministic asset naming.
 * 3. Downloads try each candidate through every mirror in order.
 */

export const MIHOMO_REPO = "MetaCubeX/mihomo";
export const METACUBEXD_REPO = "MetaCubeX/metacubexd";

/** Mirrors that proxy github.com URLs. Direct first. */
export const GITHUB_MIRRORS = [
  "", // direct
  "https://ghfast.top/",
  "https://gh-proxy.com/",
];

function mirrorize(githubUrl: string): string[] {
  return GITHUB_MIRRORS.map((prefix) => (prefix ? `${prefix}${githubUrl}` : githubUrl));
}

function ghTokenHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return token ? { authorization: `Bearer ${token}` } : {};
}

export async function resolveLatestTag(repo: string): Promise<string> {
  // Preferred: 302 redirect from releases/latest (no REST quota, mirror-friendly).
  const latestUrl = `https://github.com/${repo}/releases/latest`;
  for (const url of mirrorize(latestUrl)) {
    try {
      const res = await fetchWithRetry(url, {
        manualRedirect: true,
        attempts: 2,
        timeoutMs: 15_000,
      });
      if (res.statusCode >= 300 && res.statusCode < 400) {
        const location = res.headers.location;
        const loc = Array.isArray(location) ? location[0] : location;
        const tag = loc?.match(/\/releases\/tag\/([^/?#]+)\/?$/)?.[1];
        if (tag) return decodeURIComponent(tag);
      }
      await res.text(); // drain
    } catch {
      // try next mirror
    }
  }
  // Fallback: REST API.
  const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
  const res = await fetchWithRetry(apiUrl, {
    attempts: 2,
    timeoutMs: 15_000,
    headers: { accept: "application/vnd.github+json", ...ghTokenHeaders() },
  });
  if (res.statusCode !== 200)
    throw new Error(`Failed to resolve latest tag for ${repo} (HTTP ${res.statusCode})`);
  const data = JSON.parse(await res.text()) as { tag_name?: string };
  if (!data.tag_name) throw new Error(`GitHub API response missing tag_name for ${repo}`);
  return data.tag_name;
}

export interface ReleaseAsset {
  name: string;
  url: string; // browser_download_url
}

export async function listReleaseAssets(repo: string, tag: string): Promise<ReleaseAsset[]> {
  const apiUrl = `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const res = await fetchWithRetry(apiUrl, {
    attempts: 2,
    timeoutMs: 15_000,
    headers: { accept: "application/vnd.github+json", ...ghTokenHeaders() },
  });
  if (res.statusCode !== 200) return [];
  const data = JSON.parse(await res.text()) as {
    assets?: Array<{ name: string; browser_download_url: string }>;
  };
  return (data.assets ?? []).map((a) => ({ name: a.name, url: a.browser_download_url }));
}

const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "ghfast.top",
  "gh-proxy.com",
]);

function assertAllowedDownload(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error(`Invalid download URL: ${url}`);
  }
  if (!ALLOWED_DOWNLOAD_HOSTS.has(host)) {
    throw new Error(`Refusing to download from untrusted host: ${host}`);
  }
}

export interface DownloadAssetOptions {
  dest: string;
  /** Exact asset names to try, most preferred first. */
  candidates: string[];
  /** Asset list from the REST API; when empty, names are synthesized from the tag. */
  assets?: ReleaseAsset[];
  tag: string;
  repo: string;
  onProgress?: (downloaded: number, total: number | undefined) => void;
}

/**
 * Download the first matching release asset, trying every mirror for each
 * candidate name. Returns the asset name that succeeded.
 */
export async function downloadReleaseAsset(opts: DownloadAssetOptions): Promise<string> {
  const errors: string[] = [];
  for (const name of opts.candidates) {
    const direct =
      opts.assets?.find((a) => a.name === name)?.url ??
      `https://github.com/${opts.repo}/releases/download/${opts.tag}/${name}`;
    for (const url of mirrorize(direct)) {
      assertAllowedDownload(url);
      try {
        await downloadToFile(url, opts.dest, { onProgress: opts.onProgress });
        return name;
      } catch (err) {
        errors.push(`${name} via ${new URL(url).host}: ${(err as Error).message}`);
      }
    }
  }
  throw new Error(`All download attempts failed:\n  ${errors.join("\n  ")}`);
}

export { USER_AGENT };
