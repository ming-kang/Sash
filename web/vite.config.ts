import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig, type Plugin } from "vite";

const webRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * Splits the LXGW WenKai Lite source font (web/fonts/) into unicode-range
 * woff2 chunks under web/src/assets/fonts/lxgw/, so the dashboard downloads
 * only the glyph slices a page actually renders instead of one 5 MB file.
 * Runs in both `vite` dev and `vite build`; regeneration is content-stamped
 * and skipped while the source font is unchanged.
 */
function fontSplitPlugin(): Plugin {
  const sourceFont = path.join(webRoot, "fonts", "LXGWWenKaiLite-Regular.woff2");
  const outDir = path.join(webRoot, "src", "assets", "fonts", "lxgw");
  return {
    name: "sash:font-split",
    async buildStart() {
      const stamp = crypto
        .createHash("sha256")
        .update(fs.readFileSync(sourceFont))
        .update("\0cn-font-split@7\0")
        .digest("hex");
      const stampFile = path.join(outDir, ".stamp");
      const resultCss = path.join(outDir, "result.css");
      if (
        fs.existsSync(resultCss) &&
        fs.existsSync(stampFile) &&
        fs.readFileSync(stampFile, "utf8") === stamp
      ) {
        return;
      }
      const { fontSplit } = await import("cn-font-split").catch(() => {
        throw new Error(
          "[font-split] cn-font-split is not installed; run `npm install` first. " +
            "Its postinstall downloads a native subsetter binary from GitHub — if that is " +
            "unreachable, retry with a mirror, e.g. " +
            "CN_FONT_SPLIT_GH_HOST=https://gh-proxy.com/https://github.com " +
            "node node_modules/cn-font-split/dist/cli.js i default",
        );
      });
      fs.rmSync(outDir, { recursive: true, force: true });
      try {
        await fontSplit({
          input: sourceFont,
          outDir,
          css: { fontFamily: "LXGW WenKai Lite", fontDisplay: "swap" },
          silent: true,
        });
      } catch (error) {
        throw new Error(
          `[font-split] failed to split ${sourceFont}: ${(error as Error).message}. ` +
            "The native subsetter binary may be missing; install it with " +
            "`node node_modules/cn-font-split/dist/cli.js i default` (set " +
            "CN_FONT_SPLIT_GH_HOST to a GitHub mirror where needed).",
        );
      }
      // Drop the preview/report artifacts; keep only chunks and result.css.
      for (const junk of ["index.html", "index.proto", "reporter.bin"]) {
        fs.rmSync(path.join(outDir, junk), { force: true });
      }
      fs.writeFileSync(stampFile, stamp, { encoding: "utf8" });
      console.log("[font-split] web/fonts/LXGWWenKaiLite-Regular.woff2 -> src/assets/fonts/lxgw/");
    },
  };
}

export default defineConfig({
  plugins: [fontSplitPlugin(), vue()],
  base: "./",
  root: webRoot,
  build: {
    outDir: path.resolve(webRoot, "../dist/ui"),
    emptyOutDir: true,
    target: "es2022",
    minify: "esbuild",
    cssMinify: true,
    // Font chunks stay discrete files: they are fingerprinted, fetched in
    // parallel and cached immutably by the daemon, never inlined into CSS.
    assetsInlineLimit: (filePath) => (filePath.endsWith(".woff2") ? false : undefined),
  },
  server: {
    port: 5173,
    proxy: {
      "/sash": "http://127.0.0.1:19090",
      "/core": {
        target: "http://127.0.0.1:19090",
        ws: true,
      },
    },
  },
});
