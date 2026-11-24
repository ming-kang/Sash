import { execFile } from "node:child_process";
import { connect } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import type { ControllerTarget } from "../daemon/proxy.js";

const run = promisify(execFile);

export function windowsOwnsControllerConnection(
  table: string,
  port: number,
  clientPort: number,
  pid: number,
): boolean {
  const local = `127.0.0.1:${port}`;
  const remote = `127.0.0.1:${clientPort}`;
  return table.split("\n").some((line) => {
    const [protocol, localAddress, remoteAddress, state, owner] = line.trim().split(/\s+/);
    return (
      protocol === "TCP" &&
      localAddress === local &&
      remoteAddress === remote &&
      state === "ESTABLISHED" &&
      owner === String(pid)
    );
  });
}

export function windowsControllerConnection(
  port: number,
  corePid: () => number | undefined,
): NonNullable<ControllerTarget["createConnection"]> {
  return (_options, callback) => {
    const pid = corePid();
    const systemRoot = process.env.SystemRoot;
    if (!pid || !systemRoot || !path.isAbsolute(systemRoot)) {
      callback(
        new Error("Privileged Core connection ownership is unavailable"),
        undefined as never,
      );
      return;
    }
    const socket = connect(port, "127.0.0.1");
    const fail = (error: Error): void => {
      socket.destroy();
      callback(error, undefined as never);
    };
    socket.once("error", fail);
    socket.once("connect", () => {
      // Confirm the peer on this exact socket before releasing the bearer.
      void run(path.join(systemRoot, "System32", "netstat.exe"), ["-ano", "-p", "tcp"], {
        timeout: 3000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      }).then(
        ({ stdout }) => {
          if (
            !socket.destroyed &&
            socket.localPort &&
            corePid() === pid &&
            windowsOwnsControllerConnection(stdout, port, socket.localPort, pid)
          ) {
            socket.removeListener("error", fail);
            callback(null, socket);
          } else fail(new Error("Privileged Core did not own the controller connection"));
        },
        () => fail(new Error("Could not verify privileged Core controller connection")),
      );
    });
  };
}
