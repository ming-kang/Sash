import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type TsdownPlugin } from "tsdown";

const REQUIRE_BANNER =
  'import { createRequire as __sashCreateRequire } from "node:module"; const require = __sashCreateRequire(import.meta.url);';

// A bundle cannot enable the V8 compile cache for itself: the module graph
// compiles before any module body runs. Best-effort; the CLI must start without it.
const launchers: Record<string, string> = {
  "cli.bundle": "cli.js",
  "daemon-entry.bundle": "daemon-entry.js",
  "autostart-entry.bundle": "autostart-entry.js",
};

interface BundledPackage {
  name: string;
  version: string;
  license: string;
  text: string;
}

function bundledPackages(moduleIds: readonly string[]): BundledPackage[] {
  const seen = new Set<string>();
  const packages: BundledPackage[] = [];
  for (const raw of moduleIds) {
    const id = raw.startsWith("file:") ? fileURLToPath(raw) : raw.split("?")[0];
    const matches = [...id.matchAll(/node_modules[/\\]((?:@[^/\\]+[/\\])?[^/\\]+)/g)];
    const last = matches.at(-1);
    const name = last?.[1];
    if (!last || name === undefined || name.startsWith(".") || !fs.existsSync(id)) continue;
    const dir = id.slice(0, last.index) + `node_modules/${name}`;
    if (seen.has(dir)) continue;
    seen.add(dir);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
        license?: string;
      };
      const licenseFile = fs
        .readdirSync(dir)
        .find((file) => /^licen[cs]e[.-]/i.test(file) || /^licen[cs]e$/i.test(file));
      const text = licenseFile
        ? fs.readFileSync(path.join(dir, licenseFile), "utf8").trim()
        : "";
      packages.push({
        name: manifest.name ?? name,
        version: manifest.version ?? "",
        license: manifest.license ?? "",
        text,
      });
    } catch {
      continue;
    }
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

function licenseDocument(packages: BundledPackage[]): string {
  const sections = packages.map(
    (pkg) => `## ${pkg.name} - ${pkg.version} (${pkg.license})${pkg.text ? `\n\n${pkg.text}` : ""}`,
  );
  return `# Licenses\n\nThe app bundles dependencies which contain the following licenses:\n\n${sections.join("\n\n")}\n`;
}

function sashDist(): TsdownPlugin {
  return {
    name: "sash-dist",
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== "chunk" || !file.isEntry || !file.fileName.endsWith(".js"))
          continue;
        const base = file.fileName.replace(/\.js$/, "");
        const notices = licenseDocument(bundledPackages(Object.keys(file.modules)));
        this.emitFile({
          type: "asset",
          fileName: `${base}.LICENSE.md`,
          source: notices,
        });
        file.code += `\n/*\n${notices.replaceAll("*/", "* /")}\n*/\n`;
        const launcher = launchers[base];
        if (launcher) {
          this.emitFile({
            type: "asset",
            fileName: launcher,
            source: `#!/usr/bin/env node\nimport { enableCompileCache } from "node:module";\ntry {\n  enableCompileCache();\n} catch {}\nawait import("./${file.fileName}");\n`,
          });
        }
      }
    },
  };
}

const entries = [
  "cli.bundle:src/cli.ts",
  "daemon-entry.bundle:src/daemon/entry.ts",
  "autostart-entry.bundle:src/autostart/entry.ts",
  "webui:src/webui.ts",
  "profile-worker:src/profile-worker.ts",
  "sash-installation:src/sash-installation.ts",
];

// Each entry is a self-contained single-input build: codeSplitting is only
// allowed to be disabled that way, and per-entry license files need the
// entry's own module list anyway.
export default entries.map((spec) => {
  const [name, source] = spec.split(":", 2);
  return defineConfig({
    entry: { [name]: source },
    platform: "node",
    format: "es",
    target: "node24",
    outDir: "dist",
    minify: false,
    sourcemap: false,
    clean: false,
    bin: false,
    dts: false,
    checks: { bundlerTimings: false },
    deps: {
      onlyBundle: [
        "@fastify/ajv-compiler",
        "@fastify/deepmerge",
        "@fastify/error",
        "@fastify/fast-json-stringify-compiler",
        "@fastify/forwarded",
        "@fastify/merge-json-schemas",
        "@fastify/proxy-addr",
        "@pinojs/redact",
        "abstract-logging",
        "ajv",
        "ajv-formats",
        "atomic-sleep",
        "avvio",
        "commander",
        "cookie",
        "dequal",
        "fast-decode-uri-component",
        "fast-deep-equal",
        "fast-json-stringify",
        "fast-querystring",
        "fast-uri",
        "fastify",
        "fastq",
        "find-my-way",
        "ipaddr.js",
        "json-schema-ref-resolver",
        "json-schema-traverse",
        "light-my-request",
        "on-exit-leak-free",
        "pend",
        "pino",
        "pino-std-serializers",
        "process-warning",
        "quick-format-unescaped",
        "ret",
        "reusify",
        "rfdc",
        "safe-regex2",
        "safe-stable-stringify",
        "secure-json-parse",
        "semver",
        "set-cookie-parser",
        "sonic-boom",
        "thread-stream",
        "toad-cache",
        "undici",
        "yaml",
        "yauzl",
        "zod",
      ],
    },
    banner: { js: REQUIRE_BANNER },
    outExtensions: () => ({ js: ".js" }),
    outputOptions: { codeSplitting: false },
    plugins: [sashDist()],
  });
});
