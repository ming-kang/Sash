import { downloadToFile, fetchWithRetry, USER_AGENT } from "./http.js";

/**
 * GitHub release access without hard dependency on the REST API:
 *
 * 1. Latest tag is resolved from the `releases/latest` 302 redirect, which does
 *    not consume the (60/h anonymous) REST rate limit and works through page
 *    mirrors such as ghfast.top.
 * 2. Asset listing uses the REST API when reachable (supports GITHUB_TOKEN /
 *    GH_TOKEN); otherwise falls back to synthesized candidate names since
 *    mihomo uses deterministic asset naming.
 * 3. Downloads try each candidate through every mirror in order.
 */

export const MIHOMO_REPO = "MetaCubeX/mihomo";

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

  // Fallback: GitHub REST API (consumes rate limit, direct only)
  const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
  const res = await fetchWithRetry(apiUrl, {
    headers: {
      accept: "application/vnd.github+json",
      ...ghTokenHeaders(),
    },
    attempts: 2,
    timeoutMs: 15_000,
  });
  if (res.statusCode !== 200) {
    throw new Error(`Failed to resolve latest release for ${repo}: HTTP ${res.statusCode}`);
  }
  const text = await res.text();
  let data: { tag_name?: string } | undefined;
  try {
    data = JSON.parse(text) as { tag_name?: string };
  } catch {
    // ignore
  }
  if (!data?.tag_name) {
    throw new Error(`GitHub release response for ${repo} missing tag_name`);
  }
  return data.tag_name;
}

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export async function listReleaseAssets(repo: string, tag: string): Promise<ReleaseAsset[]> {
  const apiUrl = `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const res = await fetchWithRetry(apiUrl, {
    headers: {
      accept: "application/vnd.github+json",
      ...ghTokenHeaders(),
    },
    attempts: 2,
    timeoutMs: 15_000,
  });
  if (res.statusCode !== 200) {
    throw new Error(`Failed to list release assets for ${repo}@${tag}: HTTP ${res.statusCode}`);
  }
  const text = await res.text();
  let data: { assets?: ReleaseAsset[] } | undefined;
  try {
    data = JSON.parse(text) as { assets?: ReleaseAsset[] };
  } catch {
    // ignore
  }
  return Array.isArray(data?.assets) ? data.assets : [];
}

export interface DownloadOptions {
  repo: string;
  tag: string;
  assets: ReleaseAsset[];
  candidates: string[];
  dest: string;
  onProgress?: (downloaded: number, total: number | undefined) => void;
}

export async function downloadReleaseAsset(opts: DownloadOptions): Promise<string> {
  const matched = opts.candidates.find((candidate) =>
    opts.assets.some((a) => a.name.toLowerCase() === candidate.toLowerCase()),
  );
  const chosenName = matched ?? opts.candidates[0];
  if (!chosenName) {
    throw new Error(`No candidate asset name provided for ${opts.repo}@${opts.tag}`);
  }

  const directUrl = `https://github.com/${opts.repo}/releases/download/${opts.tag}/${chosenName}`;
  const urls = mirrorize(directUrl);

  let lastError: Error | undefined;
  for (const url of urls) {
    try {
      await downloadToFile(url, opts.dest, {
        onProgress: opts.onProgress,
        stallMs: 60_000,
      });
      return chosenName;
    } catch (err) {
      lastError = err as Error;
      // try next mirror
    }
  }

  throw new Error(
    `Failed to download ${chosenName} from all mirrors: ${lastError?.message ?? "unknown error"}`,
  );
}

export { USER_AGENT };
