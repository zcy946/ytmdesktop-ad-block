import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { XrayOutbound } from "./nodes";

const host = "127.0.0.1";

async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close(error => {
        if (error) reject(error);
        else if (!address || typeof address === "string") reject(new Error("Could not allocate a local proxy port."));
        else resolve(address.port);
      });
    });
  });
}

function acceptsSocks(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host, port });
    const finish = (ready: boolean) => {
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(250);
    socket.once("connect", () => socket.write(Buffer.from([5, 1, 0])));
    socket.once("data", data => finish(data[0] === 5 && data[1] === 0));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.once("end", () => finish(false));
  });
}

export interface RunningXray {
  child: ChildProcess;
  proxyRules: string;
}

export async function runXray(
  executable: string,
  outbound: XrayOutbound,
  children: Set<ChildProcess>,
  signal: AbortSignal,
): Promise<RunningXray> {
  const port = await freePort();
  signal.throwIfAborted();
  const child = spawn(executable, ["run", "-config", "stdin:", "-format", "json"], {
    cwd: dirname(executable),
    windowsHide: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  children.add(child);
  child.once("close", () => children.delete(child));
  let failed = false;
  child.once("error", () => { failed = true; });
  child.stdin.on("error", () => { failed = true; });
  // Passing credentials over stdin keeps them out of command lines and temporary files.
  child.stdin.end(JSON.stringify({
    log: { loglevel: "none" },
    inbounds: [{ listen: host, port, protocol: "socks", settings: { auth: "noauth", udp: false } }],
    outbounds: [outbound],
  }));

  try {
    const deadline = Date.now() + 4_000;
    while (!failed && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      signal.throwIfAborted();
      if (await acceptsSocks(port)) {
        signal.throwIfAborted();
        if (failed || child.exitCode !== null || child.signalCode !== null) break;
        return { child, proxyRules: `socks5://${host}:${port}` };
      }
      await delay(100, undefined, { signal });
    }
    throw new Error("Xray could not start this node. Check the executable and node configuration.");
  } catch (error) {
    child.kill();
    throw error;
  }
}
