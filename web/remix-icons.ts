import type { Plugin } from "vite";

/**
 * @remixicon/vue 4.9 exports only a single prebuilt module. Its component
 * factories lack PURE annotations, so unused icons otherwise survive the build.
 * Annotate only that package's icon factories; retain the official components.
 */
export function remixIconsPlugin(): Plugin {
  return {
    name: "sash:remix-icons",
    enforce: "pre",
    transform(code, id) {
      if (!id.replaceAll("\\", "/").endsWith("/@remixicon/vue/index.mjs")) return;
      const factory = /defineComponent\s+as\s+([\w$]+)/.exec(code)?.[1];
      if (!factory) this.error("Remix Icon module changed; review its component entry points.");
      const calls = new RegExp(`\\b${factory}\\(\\{name:"Ri`, "g");
      const annotated = code.replace(calls, `/* @__PURE__ */${factory}({name:"Ri`);
      if (annotated === code) this.error("Remix Icon factories could not be identified.");
      return { code: annotated, map: null };
    },
  };
}
