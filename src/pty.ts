import { spawn, type IPty } from "node-pty";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { Db } from "./db.js";

const DEFAULT_SHELL =
  process.platform === "win32" ? "powershell.exe" : (process.env["SHELL"] ?? "/bin/bash");

/**
 * The escape hatch: a real PTY in the session's working directory.
 *
 * This is deliberately outside the approval gate. It is not the agent acting,
 * it is the operator acting directly -- the same trust boundary as SSH'ing to
 * the box. Routing it through canUseTool would mean asking yourself for
 * permission. The gate exists to supervise Claude, not you.
 *
 * The consequence is that whoever reaches this endpoint has a shell as the
 * agentd user, so the network perimeter (Tailscale, never Funnel) is the only
 * thing standing in front of it. Same posture as exposing SSH.
 */
export interface PtySocket {
  wss: WebSocketServer;
  /** Resolve the directory a terminal should open in, given ?session= or ?cwd=. */
  resolveCwd(sessionId: string | null, explicit: string | null): string;
}

export function createPtySocket(db: Db, workRoot: string): PtySocket {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (socket: WebSocket, _req: IncomingMessage, cwd: string) => {
    let term: IPty;
    try {
      term = spawn(DEFAULT_SHELL, [], {
        name: "xterm-color",
        cols: 80,
        rows: 24,
        cwd,
        env: process.env as Record<string, string>,
      });
    } catch (err) {
      socket.send(
        JSON.stringify({
          type: "error",
          error: `failed to start shell: ${err instanceof Error ? err.message : String(err)}`,
        }),
      );
      socket.close();
      return;
    }

    socket.send(JSON.stringify({ type: "ready", cwd, shell: DEFAULT_SHELL }));
    term.onData((data) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: "data", data }));
      }
    });
    term.onExit(({ exitCode }) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: "exit", exitCode }));
        socket.close();
      }
    });

    socket.on("message", (raw) => {
      let msg: { type?: string; data?: string; cols?: number; rows?: number };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === "data" && typeof msg.data === "string") {
        term.write(msg.data);
      } else if (msg.type === "resize" && msg.cols && msg.rows) {
        // Clamped: a hostile or buggy client should not be able to ask for a
        // 10-million-column terminal.
        try {
          term.resize(
            Math.max(2, Math.min(500, Math.floor(msg.cols))),
            Math.max(2, Math.min(300, Math.floor(msg.rows))),
          );
        } catch {
          /* the pty may already be gone */
        }
      }
    });

    const kill = (): void => {
      try {
        term.kill();
      } catch {
        /* already dead */
      }
    };
    socket.on("close", kill);
    socket.on("error", kill);
  });

  return {
    wss,
    resolveCwd(sessionId, explicit) {
      if (sessionId) {
        const row = db.prepare(`SELECT cwd FROM sessions WHERE id = ?`).get(sessionId) as
          | { cwd: string }
          | undefined;
        if (row) return row.cwd;
      }
      return explicit ?? workRoot;
    },
  };
}
