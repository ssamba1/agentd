import { WebSocketServer, type WebSocket } from "ws";
import type { Bus } from "./bus.js";
import type { Db } from "./db.js";

/**
 * Live updates for a foregrounded client.
 *
 * Deliberately dumb: it forwards bus events and nothing else. iOS suspends the
 * socket whenever the PWA backgrounds, so a client can miss arbitrary spans of
 * events and must never depend on having seen them all. Two things make that
 * survivable:
 *
 *  - Every event carries the `events.id` it was journalled under, so a
 *    reconnecting client can ask for everything after its last cursor.
 *  - `hello` on connect reports the current cursor, letting a client that has
 *    been away decide between catching up and refetching from scratch.
 */
export function createEventSocket(bus: Bus, db: Db): WebSocketServer {
  // noServer: agentd serves two WebSocket endpoints, so upgrade routing is done
  // once in main.ts rather than letting each server race for the event.
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (socket: WebSocket) => {
    const cursor = (db.prepare(`SELECT COALESCE(MAX(id), 0) AS c FROM events`).get() as { c: number })
      .c;
    send(socket, { kind: "hello", cursor, ts: Date.now() });

    const unsubscribe = bus.subscribe((event) => send(socket, event));

    // A client that stops responding to pings is gone even if the TCP
    // connection has not noticed yet -- the exact failure mode that makes a
    // phone's socket look alive long after the app was suspended.
    let alive = true;
    socket.on("pong", () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }, 30_000);

    socket.on("message", (raw) => {
      // The only client->server message is a catch-up request; everything else
      // goes over REST, where it can be retried and cached.
      try {
        const msg = JSON.parse(String(raw)) as { type?: string; after?: number; session?: string };
        if (msg.type !== "catchup") return;
        const after = Number.isFinite(msg.after) ? Number(msg.after) : 0;
        const rows = msg.session
          ? db
              .prepare(
                `SELECT * FROM events WHERE session_id = ? AND id > ? ORDER BY id LIMIT 500`,
              )
              .all(msg.session, after)
          : db.prepare(`SELECT * FROM events WHERE id > ? ORDER BY id LIMIT 500`).all(after);
        send(socket, { kind: "catchup", events: rows, ts: Date.now() });
      } catch {
        send(socket, { kind: "error", error: "malformed message", ts: Date.now() });
      }
    });

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });

  return wss;
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState !== socket.OPEN) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    /* a dead socket is the close handler's problem, not the sender's */
  }
}
