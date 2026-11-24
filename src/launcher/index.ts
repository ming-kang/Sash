import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import type { Socket } from "node:net";
import type { CoreEngine } from "../engine/index.js";
import type { SashLayout } from "../paths.js";
import { buildSanitizedEnv, withPrivateAppendLogFds } from "../process.js";
import type { SashSettings } from "../settings.js";
import type { HelperClient } from "./protocol.js";

export interface PrivilegedCore {
  pid: number;
  controller: { connect(): Socket };
  alive(): Promise<boolean>;
  reload(configText: string): Promise<void>;
  stop(): Promise<void>;
}

export type LaunchedCore =
  | { mode: "direct"; child: ChildProcess }
  | { mode: "privileged"; child: PrivilegedCore };

export interface CoreLauncher {
  launch(layout: SashLayout, settings: SashSettings): LaunchedCore | Promise<LaunchedCore>;
}

export function directCoreLauncher(engine: CoreEngine): CoreLauncher {
  return {
    launch: (layout) => ({
      mode: "direct",
      child: withPrivateAppendLogFds(
        layout.coreLogFile,
        layout.coreErrLogFile,
        ({ stdoutFd, stderrFd }) =>
          spawn(layout.coreExe, engine.spawnArguments(layout), {
            cwd: layout.root,
            stdio: ["ignore", stdoutFd, stderrFd],
            windowsHide: true,
            env: buildSanitizedEnv(),
          }),
      ),
    }),
  };
}

export async function coreSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export function privilegedCoreLauncher(connect: () => HelperClient): CoreLauncher {
  return {
    async launch(layout) {
      const configText = await fs.promises.readFile(layout.configFile, "utf8");
      const client = connect();
      try {
        const { pid, coreSha256: digest } = await client.start(configText);
        return {
          mode: "privileged",
          child: {
            pid,
            controller: { connect: () => client.connectController() },
            reload: (configText) => client.reload(configText),
            async alive() {
              try {
                const status = await client.status();
                if (status.pid === pid && status.coreSha256 === digest) return true;
                client.close();
                return false;
              } catch (error) {
                client.close();
                throw error;
              }
            },
            async stop() {
              try {
                await client.stop();
              } finally {
                client.close();
              }
            },
          },
        };
      } catch (error) {
        client.close();
        throw error;
      }
    },
  };
}
