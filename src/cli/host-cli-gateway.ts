/**
 * Host-side unix-socket CLI gateway.
 *
 * Isolated provider sandboxes (Codex shell, and other restricted CLIs) cannot
 * be given a raw loopback hole. They MAY reach this socket when the host
 * daemon created it at `~/.ravi/cli-gateway.sock` (mode 0600) and the caller
 * presents a live `RAVI_CONTEXT_KEY`.
 *
 * Handlers run in-process on the daemon. Do not block the event loop on
 * `process.stdin` from this path (audit metadata, TTY probes, prompts).
 *
 * The HTTP listener on `RAVI_HTTP_PORT` stays optional and loopback-bound.
 * This unix listener is independent of that port.
 */

import { chmodSync, linkSync, lstatSync, renameSync, type Stats, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getRaviStateDir } from "../utils/paths.js";
import { logger } from "../utils/logger.js";
import { HOST_CLI_GATEWAY_ENV, getHostCliGatewaySocketPath, probeUnixSocket } from "../isolation/execution-plane.js";
import { createGatewayHandlerContext, handleGatewayRequest } from "../sdk/gateway/server.js";
import type { GatewayConfig, GatewayHandlerContext } from "../sdk/gateway/server.js";

const log = logger.child("cli:host-gateway");

export { HOST_CLI_GATEWAY_ENV, HOST_CLI_GATEWAY_INTERNAL_ENV } from "../isolation/execution-plane.js";
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface HostCliGatewayHandle {
  socketPath: string;
  stop(): Promise<void>;
}

export interface StartHostCliGatewayOptions {
  socketPath?: string;
  gateway?: GatewayConfig;
  env?: NodeJS.ProcessEnv;
  handleRequest?: (request: Request) => Promise<Response> | Response;
}

export function isHostCliGatewayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[HOST_CLI_GATEWAY_ENV]?.trim();
  return raw !== "0" && raw?.toLowerCase() !== "false" && raw?.toLowerCase() !== "off";
}

export async function startHostCliGateway(
  options: StartHostCliGatewayOptions = {},
): Promise<HostCliGatewayHandle | null> {
  const env = options.env ?? process.env;
  if (!isHostCliGatewayEnabled(env)) {
    log.info("Host CLI gateway disabled");
    return null;
  }

  const socketPath = options.socketPath ?? getHostCliGatewaySocketPath(getRaviStateDir(env));
  const ctx = options.handleRequest ? null : createGatewayHandlerContext(options.gateway ?? {});
  const handleRequest = options.handleRequest;

  if (!(await clearStaleSocket(socketPath))) return null;

  const server = createServer((req, res) => {
    void handleUnixRequest(req, res, ctx, handleRequest).catch((error) => {
      log.error("Host CLI gateway request failed", { error });
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: "InternalError" }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  try {
    chmodSync(socketPath, 0o600);
  } catch (error) {
    log.warn("Failed to restrict host CLI gateway socket mode", { socketPath, error });
  }

  // The socket file this server owns. stop() compares against it so a
  // stopping daemon never removes a successor's socket.
  const ownSocket = lstatOrNull(socketPath);

  log.info("Host CLI gateway ready", { socketPath });

  return {
    socketPath,
    async stop() {
      // Closing a unix-socket server unlinks its path by name (Bun and
      // libuv). When the path now holds someone else's file, keep a hard
      // link to it across the close and move it back afterwards.
      const current = lstatOrNull(socketPath);
      const foreign = current !== null && !sameFile(current, ownSocket);
      const preservedPath = foreign ? preserveForeignFile(socketPath) : null;
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((closeError) => {
            if (closeError) reject(closeError);
            else resolve();
          });
        });
      } finally {
        if (preservedPath) restoreForeignFile(preservedPath, socketPath);
      }
      if (!foreign) {
        const remaining = lstatOrNull(socketPath);
        if (remaining && sameFile(remaining, ownSocket)) {
          try {
            unlinkSync(socketPath);
          } catch {
            // Best-effort cleanup; the next daemon clears a stale socket on start.
          }
        }
      }
      log.info("Host CLI gateway stopped", { socketPath });
    },
  };
}

/**
 * Make `socketPath` free for listen(). Returns false (leave everything as is)
 * when the path holds anything but a stale socket of ours:
 * - a live socket: another daemon is serving it; never unlink it;
 * - not a socket (a regular file, a dir, a symlink): not ours to delete;
 * - a socket owned by another user.
 */
async function clearStaleSocket(socketPath: string): Promise<boolean> {
  let stats: Stats;
  try {
    stats = lstatSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return true;
    log.error("Host CLI gateway not started: cannot inspect the socket path", { socketPath, error });
    return false;
  }
  if (!stats.isSocket()) {
    log.error("Host CLI gateway not started: the socket path holds something that is not a socket", {
      socketPath,
    });
    return false;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && stats.uid !== uid) {
    log.error("Host CLI gateway not started: the socket belongs to another user", { socketPath, owner: stats.uid });
    return false;
  }
  if (await probeUnixSocket(socketPath)) {
    log.error("Host CLI gateway not started: another process is serving the socket (is a second daemon running?)", {
      socketPath,
    });
    return false;
  }
  try {
    unlinkSync(socketPath);
  } catch (error) {
    log.warn("Failed to remove stale host CLI gateway socket", { socketPath, error });
  }
  return true;
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function sameFile(a: Stats, b: Stats | null): boolean {
  return b !== null && a.dev === b.dev && a.ino === b.ino;
}

function preserveForeignFile(socketPath: string): string | null {
  const preservedPath = `${socketPath}.${process.pid}.${Date.now()}.keep`;
  try {
    linkSync(socketPath, preservedPath);
    return preservedPath;
  } catch (error) {
    log.warn("Could not protect the socket path from this gateway's shutdown", { socketPath, error });
    return null;
  }
}

function restoreForeignFile(preservedPath: string, socketPath: string): void {
  try {
    renameSync(preservedPath, socketPath);
  } catch (error) {
    log.warn("Could not restore the socket path after shutdown", { socketPath, error });
  }
  // When close() left the path alone, both names are links to the same file
  // and rename() is a no-op that keeps both: drop the extra link.
  if (lstatOrNull(preservedPath)) {
    try {
      unlinkSync(preservedPath);
    } catch {
      // Leave the extra link; it names the same file and holds no data of ours.
    }
  }
}

export async function hostCliGatewayReachable(socketPath = getHostCliGatewaySocketPath()): Promise<boolean> {
  return probeUnixSocket(socketPath);
}

async function handleUnixRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayHandlerContext | null,
  handleRequest?: (request: Request) => Promise<Response> | Response,
): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "PayloadTooLarge", limitBytes: MAX_BODY_BYTES }));
      req.destroy();
      return;
    }
    chunks.push(buffer);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");
  const method = req.method ?? "GET";
  const target = req.url ?? "/";
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }

  const request = new Request(`http://ravi-cli-gateway.local${target}`, {
    method,
    headers,
    ...(method !== "GET" && method !== "HEAD" && rawBody.length > 0 ? { body: rawBody } : {}),
  });

  const response =
    (handleRequest ? await handleRequest(request) : ctx ? await handleGatewayRequest(request, ctx) : null) ??
    new Response(JSON.stringify({ error: "NotFound" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });

  const body = Buffer.from(await response.arrayBuffer());
  const outHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    outHeaders[key] = value;
  });
  res.writeHead(response.status, outHeaders);
  res.end(body);
}
