import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue()],
  base: "./",
  root: import.meta.dirname,
  build: {
    outDir: path.resolve(import.meta.dirname, "../dist/ui"),
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
