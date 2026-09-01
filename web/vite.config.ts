import path from "node:path";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const webRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [vue()],
  base: "./",
  root: webRoot,
  build: {
    outDir: path.resolve(webRoot, "../dist/ui"),
    emptyOutDir: true,
    target: "es2022",
    minify: "esbuild",
    cssMinify: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/sash": "http://127.0.0.1:19090",
      "/core": "http://127.0.0.1:19090",
    },
  },
});
