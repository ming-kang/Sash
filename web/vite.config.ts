import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig, type Plugin } from "vite";
import { remixIconsPlugin } from "./remix-icons.js";

const webRoot = path.dirname(fileURLToPath(import.meta.url));

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
      for (const junk of ["index.html", "index.proto", "reporter.bin"]) {
        fs.rmSync(path.join(outDir, junk), { force: true });
      }
      fs.writeFileSync(stampFile, stamp, { encoding: "utf8" });
      console.log("[font-split] web/fonts/LXGWWenKaiLite-Regular.woff2 -> src/assets/fonts/lxgw/");
    },
  };
}

// The WebUI counterpart of the backend `sashDist` license emission: upstream
// legal comments are preserved at the end of each minified chunk, and complete
// license texts for every bundled npm package land in `licenses/`.
// Some packages carry no legal comments (CodeMirror, @lezer) and
// @remixicon/vue ships no license file at all, so texts come from
// node_modules/LICENSE* with explicit overrides.
function uiLicensesPlugin(): Plugin {
  const licenseSources: Record<string, string> = {
    "@remixicon/vue": path.join(webRoot, "..", "docs", "remix-icon-license.txt"),
  };
  const fontLicense = path.join(webRoot, "fonts", "OFL.txt");
  const fontLicenseFile = "LXGWWenKaiLite-OFL-1.1.txt";

  interface BundledPackage {
    name: string;
    version: string;
    license: string;
    text: string;
  }

  function bundledPackages(moduleIds: Iterable<string>): BundledPackage[] {
    const seen = new Set<string>();
    const packages: BundledPackage[] = [];
    for (const raw of moduleIds) {
      const id = raw.startsWith("file:") ? fileURLToPath(raw) : raw.split("?")[0];
      const matches = [...id.matchAll(/node_modules[/\\]((?:@[^/\\]+[/\\])?[^/\\]+)/g)];
      const last = matches.at(-1);
      const name = last?.[1];
      if (!last || name === undefined || !fs.existsSync(id)) continue;
      const dir = `${id.slice(0, last.index)}node_modules/${name}`;
      if (seen.has(dir)) continue;
      seen.add(dir);
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
          name?: string;
          version?: string;
          license?: string;
        };
        const licenseFile =
          licenseSources[manifest.name ?? name] ??
          (() => {
            const found = fs
              .readdirSync(dir)
              .find((file) => /^licen[cs]e[.-]/i.test(file) || /^licen[cs]e$/i.test(file));
            return found ? path.join(dir, found) : undefined;
          })();
        packages.push({
          name: manifest.name ?? name,
          version: manifest.version ?? "",
          license: manifest.license ?? "",
          text: licenseFile ? fs.readFileSync(licenseFile, "utf8").trim() : "",
        });
      } catch {
        // Unreadable manifest: not a real package dir.
      }
    }
    return packages.sort((a, b) => a.name.localeCompare(b.name));
  }

  return {
    name: "sash:ui-licenses",
    generateBundle() {
      const packages = bundledPackages(this.getModuleIds());
      if (packages.length === 0) {
        this.error("[ui-licenses] no bundled npm packages detected in this build");
      }
      for (const pkg of packages) {
        this.emitFile({
          type: "asset",
          fileName: `licenses/${pkg.name}.LICENSE.txt`,
          source:
            `${pkg.name} ${pkg.version} (${pkg.license})` +
            `${pkg.text ? `\n\n${pkg.text}` : ""}\n`,
        });
      }
      this.emitFile({
        type: "asset",
        fileName: `licenses/${fontLicenseFile}`,
        source: fs.readFileSync(fontLicense, "utf8"),
      });
      this.emitFile({
        type: "asset",
        fileName: "licenses/index.txt",
        source:
          "The built dashboard bundles the npm packages below; their license " +
          "texts live in this directory, and upstream license comments are " +
          "preserved alongside their code in each bundled asset. The LXGW " +
          `WenKai Lite font is SIL Open Font License 1.1 — see ${fontLicenseFile}.\n\n` +
          packages.map((pkg) => `${pkg.name} ${pkg.version} (${pkg.license})`).join("\n") +
          "\n",
      });
    },
  };
}

export default defineConfig({
  plugins: [fontSplitPlugin(), remixIconsPlugin(), uiLicensesPlugin(), vue()],
  base: "./",
  root: webRoot,
  build: {
    outDir: path.resolve(webRoot, "../dist/ui"),
    emptyOutDir: true,
    target: "es2022",
    minify: true,
    cssMinify: true,
    manifest: true,
    // Minifying turns legal comments off at both stages, so turn them back on:
    // `comments` keeps them through bundling (`/**`-style headers like Vue's
    // classify as jsdoc), `minify.codegen.legalComments` keeps them through oxc
    // (eof appends them to each chunk; non-legal comments are still dropped).
    // An `output.minify` object fully replaces Vite's `true`, hence the
    // explicit compress/mangle.
    rollupOptions: {
      output: {
        comments: { legal: true, jsdoc: true },
        minify: {
          compress: true,
          mangle: true,
          codegen: { legalComments: "eof" },
        },
      },
    },
    // Font chunks stay discrete files: fingerprinted, fetched in parallel and
    // cached immutably by the daemon, never inlined into CSS.
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
