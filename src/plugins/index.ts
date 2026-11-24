import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { errorMessage } from "../error-utils.js";
import { deepFreeze } from "../json-shape.js";
import type { PublicSashSettings } from "../settings.js";

export interface PluginProfileInfo {
  id: string;
  revision: number;
  name: string;
  url: string;
}

export interface PluginGenerateContext {
  /** Sanitized public settings; daemon and Core secrets are never exposed. */
  readonly settings: PublicSashSettings;
  readonly profile: PluginProfileInfo | null;
  readonly source: "subscription" | "default";
}

export interface PluginInfo {
  name: string;
  file: string;
  error?: string;
}

type GenerateHook = (config: Record<string, unknown>, context: PluginGenerateContext) => unknown;

interface LoadedPlugin {
  name: string;
  onGenerate?: GenerateHook;
}

const LOAD_TIMEOUT_MS = 2_000;
const HOOK_TIMEOUT_MS = 5_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Plugins are plain CommonJS-style modules under `<SASH_HOME>/plugins/*.js`,
 * evaluated in a vm context with no host globals. Node's `vm` is not a hard
 * security boundary — plugins are trusted, first-party code; the context only
 * prevents accidental access to ambient globals like `process` or `require`.
 * A plugin exports an object with an optional `onGenerate(config, context)`
 * hook; returning a plain object replaces the merged Core configuration
 * document, and returning nothing keeps the (possibly mutated) document.
 */
export class PluginRegistry {
  private readonly infos: PluginInfo[] = [];
  private loaded?: Promise<readonly LoadedPlugin[]>;

  constructor(
    private readonly dir: string,
    private readonly hookTimeoutMs = HOOK_TIMEOUT_MS,
  ) {}

  private ensureLoaded(): Promise<readonly LoadedPlugin[]> {
    if (!this.loaded) this.loaded = this.scan();
    return this.loaded;
  }

  /** Plugin list is populated by the first scan; entries never unroll. */
  list(): PluginInfo[] {
    void this.ensureLoaded();
    return [...this.infos];
  }

  async hasGenerateHooks(): Promise<boolean> {
    return (await this.ensureLoaded()).some((plugin) => plugin.onGenerate !== undefined);
  }

  private prefixedConsole(name: string): Record<string, (...args: unknown[]) => void> {
    const tag = `[sashd:plugin:${name}]`;
    return {
      log: (...args) => console.log(tag, ...args),
      info: (...args) => console.info(tag, ...args),
      warn: (...args) => console.warn(tag, ...args),
      error: (...args) => console.error(tag, ...args),
      debug: (...args) => console.debug(tag, ...args),
    };
  }

  private evaluate(file: string, code: string): LoadedPlugin {
    const moduleShim: { exports: unknown } = { exports: {} };
    const base = path.basename(file, ".js");
    const context = vm.createContext({
      module: moduleShim,
      exports: moduleShim.exports,
      console: this.prefixedConsole(base),
      structuredClone,
    });
    vm.runInContext(code, context, { filename: file, timeout: LOAD_TIMEOUT_MS });
    const definition = moduleShim.exports;
    if (!isPlainObject(definition)) {
      throw new Error("Plugin must export an object with hook functions");
    }
    const name = typeof definition.name === "string" && definition.name ? definition.name : base;
    const plugin: LoadedPlugin = { name };
    if (definition.onGenerate !== undefined) {
      if (typeof definition.onGenerate !== "function")
        throw new Error("Plugin onGenerate must be a function");
      plugin.onGenerate = definition.onGenerate as GenerateHook;
    }
    return plugin;
  }

  private async scan(): Promise<readonly LoadedPlugin[]> {
    let names: string[];
    try {
      names = (await fs.promises.readdir(this.dir)).filter((n) => n.endsWith(".js")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[sashd] plugin directory is unreadable: ${errorMessage(error)}`);
      }
      return [];
    }
    const plugins: LoadedPlugin[] = [];
    for (const name of names) {
      const file = path.join(this.dir, name);
      try {
        const code = await fs.promises.readFile(file, "utf8");
        const plugin = this.evaluate(file, code);
        plugins.push(plugin);
        this.infos.push({ name: plugin.name, file });
      } catch (error) {
        this.infos.push({ name: path.basename(name, ".js"), file, error: errorMessage(error) });
        console.warn(`[sashd] plugin ${name} failed to load: ${errorMessage(error)}`);
      }
    }
    return plugins;
  }

  // The timeout bounds how long the daemon waits on a hook's result; it
  // cannot preempt a synchronously looping hook, which still runs on the
  // daemon thread. Plugins are trusted code, so this guards async stalls,
  // not hostile code.
  private withTimeout<T>(value: T | Promise<T>, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${this.hookTimeoutMs}ms`)),
        this.hookTimeoutMs,
      );
    });
    return Promise.race([Promise.resolve(value), timeout]).finally(() =>
      clearTimeout(timer),
    ) as Promise<T>;
  }

  /**
   * Run every loaded onGenerate hook in sorted-file order. Each hook receives
   * a clone of the current document so a failing plugin cannot corrupt state
   * for the plugins after it; the shared context is deep-frozen so a plugin
   * cannot leak mutations into the hooks that run after it. Failures are
   * logged and skipped. When no plugin exports onGenerate the input is
   * returned untouched — callers can skip serializing by comparing identity.
   */
  async applyGenerated(
    config: Record<string, unknown>,
    context: PluginGenerateContext,
  ): Promise<Record<string, unknown>> {
    const plugins = await this.ensureLoaded();
    if (!plugins.some((plugin) => plugin.onGenerate)) return config;
    const frozenContext = deepFreeze(context);
    let current = config;
    for (const plugin of plugins) {
      if (!plugin.onGenerate) continue;
      const clone = structuredClone(current);
      try {
        const result = await this.withTimeout(
          plugin.onGenerate(clone, frozenContext),
          `plugin ${plugin.name}`,
        );
        current = isPlainObject(result) ? result : clone;
      } catch (error) {
        console.warn(`[sashd] plugin ${plugin.name} onGenerate failed: ${errorMessage(error)}`);
      }
    }
    return current;
  }
}
