import crypto from "node:crypto";
import fs from "node:fs";
import { downloadToFile, ERROR_BODY_LIMIT, fetchWithRetry, USER_AGENT } from "./http.js";

/**
 * GitHub release access without hard dependency on the REST API:
 *
 * 1. Latest tag is resolved from the `releases/latest` 302 redirect, which does
 *    not consume the (60/h anonymous) REST rate limit and works through page
 *    mirrors such as ghfast.top.
 * 2. Asset metadata comes from the REST API (supports GITHUB_TOKEN / GH_TOKEN)
 *    because its publisher-provided SHA-256 digest is the trust anchor.
 * 3. Downloads may use mirrors as transports, but bytes are accepted only
 *    after matching that official digest.
 */

export const MIHOMO_REPO = "MetaCubeX/mihomo";

/** Mirrors that proxy github.com URLs. Direct first. */
export const GITHUB_MIRRORS = [
  "", // direct
  "https://ghfast.top/",
  "https://gh-proxy.com/",
];

/** Trusted initial and redirect hosts for release artifact downloads. */
export const GITHUB_DOWNLOAD_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "github-releases.githubusercontent.com",
  ...GITHUB_MIRRORS.filter(Boolean).map((mirror) => new URL(mirror).hostname.toLowerCase()),
]);

function mirrorize(githubUrl: string): string[] {
  return GITHUB_MIRRORS.map((prefix) => (prefix ? `${prefix}${githubUrl}` : githubUrl));
}

function ghTokenHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return token ? { authorization: `Bearer ${token}` } : {};
}

export async function resolveLatestTag(repo: string): Promise<string> {
  // Resolve the release identity only from GitHub itself. Mirrors remain byte
  // transports and cannot choose or downgrade the version being installed.
  const latestUrl = `https://github.com/${repo}/releases/latest`;
  try {
    const res = await fetchWithRetry(latestUrl, {
      manualRedirect: true,
      attempts: 2,
      deadlineMs: 15_000,
    });
    if (res.statusCode >= 300 && res.statusCode < 400) {
      const location = res.headers.location;
      const loc = Array.isArray(location) ? location[0] : location;
      await res.discard();
      if (loc) {
        const target = new URL(loc, latestUrl);
        if (target.protocol === "https:" && target.hostname.toLowerCase() === "github.com") {
          const tag = target.pathname.match(/\/releases\/tag\/([^/]+)\/?$/)?.[1];
          if (tag) return decodeURIComponent(tag);
        }
      }
    } else {
      await res.discard();
    }
  } catch {
    // Fall through to the official REST API.
  }

  // Fallback: GitHub REST API (consumes rate limit, direct only)
  const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
  const res = await fetchWithRetry(apiUrl, {
    headers: {
      accept: "application/vnd.github+json",
      ...ghTokenHeaders(),
    },
    attempts: 2,
    deadlineMs: 15_000,
    manualRedirect: true,
  });
  if (res.statusCode !== 200) {
    await res.text(ERROR_BODY_LIMIT);
    throw new Error(`Failed to resolve latest release for ${repo}: HTTP ${res.statusCode}`);
  }
  const text = await res.text(2 * 1024 * 1024);
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
  digest: string;
}

export async function listReleaseAssets(repo: string, tag: string): Promise<ReleaseAsset[]> {
  const apiUrl = `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const res = await fetchWithRetry(apiUrl, {
    headers: {
      accept: "application/vnd.github+json",
      ...ghTokenHeaders(),
    },
    attempts: 2,
    deadlineMs: 15_000,
    manualRedirect: true,
  });
  if (res.statusCode !== 200) {
    await res.text(ERROR_BODY_LIMIT);
    throw new Error(`Failed to list release assets for ${repo}@${tag}: HTTP ${res.statusCode}`);
  }
  const text = await res.text(8 * 1024 * 1024);
  let data: { assets?: unknown } | undefined;
  try {
    data = JSON.parse(text) as { assets?: unknown };
  } catch {
    // handled below
  }
  if (!Array.isArray(data?.assets)) {
    throw new Error(`GitHub release response for ${repo}@${tag} is missing assets`);
  }

  return data.assets.flatMap((value): ReleaseAsset[] => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const asset = value as Record<string, unknown>;
    if (
      typeof asset.name !== "string" ||
      typeof asset.browser_download_url !== "string" ||
      typeof asset.size !== "number" ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      typeof asset.digest !== "string"
    ) {
      return [];
    }
    return [
      {
        name: asset.name,
        browser_download_url: asset.browser_download_url,
        size: asset.size,
        digest: asset.digest,
      },
    ];
  });
}

export const RELEASE_ASSET_SIZE_LIMIT = 128 * 1024 * 1024;

export function parseSha256Digest(value: string): string {
  const match = value.match(/^sha256:([0-9a-f]{64})$/i);
  if (!match?.[1]) throw new Error(`Release asset has an invalid SHA-256 digest: ${value}`);
  return match[1].toLowerCase();
}

export async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
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
  const chosen = opts.candidates
    .map((candidate) =>
      opts.assets.find((asset) => asset.name.toLowerCase() === candidate.toLowerCase()),
    )
    .find((asset): asset is ReleaseAsset => asset !== undefined);
  if (!chosen) {
    throw new Error(
      `No trusted release asset matched ${opts.candidates.join(", ")} for ${opts.repo}@${opts.tag}`,
    );
  }
  if (chosen.size > RELEASE_ASSET_SIZE_LIMIT) {
    throw new Error(
      `Release asset ${chosen.name} exceeds the ${RELEASE_ASSET_SIZE_LIMIT} byte safety limit`,
    );
  }
  const expectedDigest = parseSha256Digest(chosen.digest);

  const directUrl = `https://github.com/${opts.repo}/releases/download/${opts.tag}/${chosen.name}`;
  const urls = mirrorize(directUrl);

  let lastError: Error | undefined;
  for (const url of urls) {
    try {
      await downloadToFile(url, opts.dest, {
        allowedHosts: GITHUB_DOWNLOAD_HOSTS,
        maxBytes: RELEASE_ASSET_SIZE_LIMIT,
        requireHttps: true,
        onProgress: opts.onProgress,
        stallMs: 60_000,
      });
      const actualDigest = await sha256File(opts.dest);
      if (actualDigest !== expectedDigest) {
        throw new Error(
          `SHA-256 mismatch for ${chosen.name}: expected ${expectedDigest}, got ${actualDigest}`,
        );
      }
      return chosen.name;
    } catch (err) {
      fs.rmSync(opts.dest, { force: true });
      lastError = err as Error;
      // A mirror is only a transport. Try the next source, but never accept
      // bytes that differ from the digest published by GitHub's release API.
    }
  }

  throw new Error(
    `Failed to download and verify ${chosen.name} from all mirrors: ${lastError?.message ?? "unknown error"}`,
  );
}

export { USER_AGENT };
