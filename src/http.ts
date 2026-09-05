import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve as resolvePath } from "node:path";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { ApprovalGate, MatchKind, RememberSpec } from "./gate.js";
import { McpConfigError } from "./mcp.js";
import type { PushService } from "./push.js";
import type { SessionManager } from "./session.js";
import { diffWorkspace, removeWorktree } from "./worktree.js";

const MAX_BODY_BYTES = 1_000_000;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(buf);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(400, "body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "invalid JSON body");
  }
}

function str(body: Record<string, unknown>, key: string, required: true): string;
function str(body: Record<string, unknown>, key: string, required?: false): string | undefined;
function str(body: Record<string, unknown>, key: string, required = false): string | undefined {
  const v = body[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, `missing required field: ${key}`);
    return undefined;
  }
  if (typeof v !== "string") throw new HttpError(400, `${key} must be a string`);
  return v;
}

function parseRemember(raw: unknown): RememberSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "remember must be an object");
  const r = raw as Record<string, unknown>;
  const scope = r["scope"] ?? "session";
  const matchKind = r["matchKind"] ?? "any";
  if (scope !== "session" && scope !== "global") {
    throw new HttpError(400, "remember.scope must be 'session' or 'global'");
  }
  if (matchKind !== "any" && matchKind !== "prefix" && matchKind !== "exact") {
    throw new HttpError(400, "remember.matchKind must be 'any', 'prefix', or 'exact'");
  }
  const matchValue = r["matchValue"];
  if (matchKind !== "any" && typeof matchValue !== "string") {
    throw new HttpError(400, `remember.matchValue is required for matchKind '${matchKind}'`);
  }
  return {
    scope,
    matchKind: matchKind as MatchKind,
    matchValue: typeof matchValue === "string" ? matchValue : undefined,
    note: typeof r["note"] === "string" ? r["note"] : undefined,
  };
}

export interface HttpDeps {
  /** Configured MCP server names, or null when agentd inherits everything. */
  mcpNames: string[] | null;
  db: Db;
  cfg: Config;
  gate: ApprovalGate;
  sessions: SessionManager;
  push: PushService;
  publicDir: string;
  startedAt: number;
}

type Handler = (m: RegExpMatchArray, req: IncomingMessage) => Promise<unknown> | unknown;

export function createHttpServer(deps: HttpDeps): Server {
  const { db, cfg, gate, sessions, push, publicDir, mcpNames } = deps;

  const routes: Array<{ method: string; pattern: RegExp; handle: Handler }> = [
    {
      method: "GET",
      pattern: /^\/api\/health$/,
      handle: () => ({
        ok: true,
        uptimeSec: Math.round((Date.now() - deps.startedAt) / 1000),
        liveSessions: sessions.liveCount,
        parkedApprovals: gate.pendingCount,
        approvalTtlSec: Math.round(cfg.approvalTtlMs / 1000),
        simulateEnabled: cfg.allowSimulate,
        pushEnabled: push.enabled,
      }),
    },

    // --- sessions -------------------------------------------------------
    {
      method: "GET",
      pattern: /^\/api\/sessions$/,
      handle: () => {
        const rows = db
          .prepare(`SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 100`)
          .all() as Array<Record<string, unknown>>;
        const pending = db
          .prepare(
            `SELECT session_id, COUNT(*) AS n FROM approvals
              WHERE status = 'pending' GROUP BY session_id`,
          )
          .all() as Array<{ session_id: string; n: number }>;
        const byId = new Map(pending.map((p) => [p.session_id, p.n]));
        return rows.map((r) => ({
          ...r,
          pendingApprovals: byId.get(r["id"] as string) ?? 0,
          live: sessions.isLive(r["id"] as string),
        }));
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/sessions$/,
      handle: async (_m, req) => {
        const body = await readJson(req);
        const mcp = body["mcpServers"];
        if (mcp !== undefined && (!Array.isArray(mcp) || mcp.some((x) => typeof x !== "string"))) {
          throw new HttpError(400, "mcpServers must be an array of strings");
        }
        try {
          return {
            id: await sessions.start({
              prompt: str(body, "prompt", true),
              title: str(body, "title"),
              cwd: str(body, "cwd"),
              repo: str(body, "repo"),
              branch: str(body, "branch"),
              mcpServers: mcp as string[] | undefined,
            }),
          };
        } catch (err) {
          if (err instanceof McpConfigError) throw new HttpError(400, err.message);
          throw err;
        }
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/sessions\/([\w-]+)$/,
      handle: (m) => {
        const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(m[1]);
        if (!row) throw new HttpError(404, "no such session");
        return { ...row, live: sessions.isLive(m[1]!) };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/sessions\/([\w-]+)\/message$/,
      handle: async (m, req) => {
        const body = await readJson(req);
        if (!sessions.send(m[1]!, str(body, "text", true))) {
          throw new HttpError(409, "session is not accepting input; resume it first");
        }
        return { ok: true };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/sessions\/([\w-]+)\/resume$/,
      handle: async (m, req) => {
        const body = await readJson(req);
        try {
          sessions.resume(m[1]!, str(body, "prompt", true));
        } catch (err) {
          throw new HttpError(409, err instanceof Error ? err.message : String(err));
        }
        return { ok: true };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/sessions\/([\w-]+)\/end$/,
      handle: (m) => {
        if (!sessions.end(m[1]!)) throw new HttpError(409, "session is not running");
        return { ok: true };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/sessions\/([\w-]+)\/interrupt$/,
      handle: (m) => {
        if (!sessions.interrupt(m[1]!)) throw new HttpError(409, "session is not running");
        return { ok: true };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/sessions\/([\w-]+)\/diff$/,
      handle: async (m) => {
        const row = db.prepare(`SELECT cwd FROM sessions WHERE id = ?`).get(m[1]) as
          | { cwd: string }
          | undefined;
        if (!row) throw new HttpError(404, "no such session");
        return diffWorkspace(row.cwd);
      },
    },
    {
      method: "DELETE",
      pattern: /^\/api\/sessions\/([\w-]+)\/worktree$/,
      handle: async (m, req) => {
        const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(m[1]) as
          | { cwd: string; repo: string | null; worktree: number }
          | undefined;
        if (!row) throw new HttpError(404, "no such session");
        if (!row.worktree || !row.repo) throw new HttpError(409, "session has no worktree");
        if (sessions.isLive(m[1]!)) throw new HttpError(409, "session is still running");
        const force = new URL(req.url!, "http://localhost").searchParams.get("force") === "1";
        try {
          await removeWorktree(row.repo, row.cwd, force);
        } catch (err) {
          throw new HttpError(409, err instanceof Error ? err.message : String(err));
        }
        db.prepare(`UPDATE sessions SET worktree = 0 WHERE id = ?`).run(m[1]);
        return { ok: true };
      },
    },

    // --- approvals ------------------------------------------------------
    {
      method: "GET",
      pattern: /^\/api\/approvals$/,
      handle: (_m, req) => {
        const url = new URL(req.url!, "http://localhost");
        const status = url.searchParams.get("status") ?? "pending";
        const session = url.searchParams.get("session");
        return session
          ? db
              .prepare(
                `SELECT * FROM approvals WHERE status = ? AND session_id = ?
                  ORDER BY created_at DESC LIMIT 200`,
              )
              .all(status, session)
          : db
              .prepare(`SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT 200`)
              .all(status);
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/approvals\/([\w-]+)$/,
      handle: (m) => {
        const row = db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(m[1]);
        if (!row) throw new HttpError(404, "no such approval");
        return row;
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/approvals\/([\w-]+)\/resolve$/,
      handle: async (m, req) => {
        const body = await readJson(req);
        const decision = str(body, "decision", true);
        if (decision !== "allow" && decision !== "deny") {
          throw new HttpError(400, "decision must be 'allow' or 'deny'");
        }
        const result = gate.decide(m[1]!, decision, {
          message: str(body, "message"),
          remember: parseRemember(body["remember"]),
        });
        if (!result.ok) throw new HttpError(409, result.reason ?? "could not resolve");
        return result;
      },
    },

    // --- rules ----------------------------------------------------------
    {
      method: "GET",
      pattern: /^\/api\/mcp$/,
      handle: () => ({ strict: mcpNames !== null, servers: mcpNames ?? [] }),
    },
    {
      method: "GET",
      pattern: /^\/api\/rules$/,
      handle: () => db.prepare(`SELECT * FROM rules ORDER BY created_at DESC`).all(),
    },
    {
      method: "POST",
      pattern: /^\/api\/rules$/,
      handle: async (_m, req) => {
        const body = await readJson(req);
        const action = str(body, "action", true);
        const matchKind = str(body, "matchKind") ?? "any";
        if (action !== "allow" && action !== "deny") {
          throw new HttpError(400, "action must be 'allow' or 'deny'");
        }
        if (matchKind !== "any" && matchKind !== "prefix" && matchKind !== "exact") {
          throw new HttpError(400, "matchKind must be 'any', 'prefix', or 'exact'");
        }
        const matchValue = str(body, "matchValue");
        if (matchKind !== "any" && matchValue === undefined) {
          throw new HttpError(400, `matchValue is required for matchKind '${matchKind}'`);
        }
        return {
          id: gate.addRule({
            sessionId: str(body, "sessionId") ?? null,
            toolName: str(body, "toolName", true),
            matchKind,
            matchValue: matchValue ?? null,
            action,
            note: str(body, "note"),
          }),
        };
      },
    },
    {
      method: "DELETE",
      pattern: /^\/api\/rules\/([\w-]+)$/,
      handle: (m) => {
        if (db.prepare(`DELETE FROM rules WHERE id = ?`).run(m[1]).changes === 0) {
          throw new HttpError(404, "no such rule");
        }
        return { ok: true };
      },
    },

    // --- events ---------------------------------------------------------
    {
      method: "GET",
      pattern: /^\/api\/events$/,
      handle: (_m, req) => {
        const url = new URL(req.url!, "http://localhost");
        const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0;
        const session = url.searchParams.get("session");
        return session
          ? db
              .prepare(`SELECT * FROM events WHERE session_id = ? AND id > ? ORDER BY id LIMIT 500`)
              .all(session, after)
          : db.prepare(`SELECT * FROM events WHERE id > ? ORDER BY id LIMIT 500`).all(after);
      },
    },

    // --- push -----------------------------------------------------------
    {
      method: "GET",
      pattern: /^\/api\/push\/key$/,
      handle: () => ({ publicKey: push.publicKey, enabled: push.enabled }),
    },
    {
      method: "GET",
      pattern: /^\/api\/push\/subscriptions$/,
      handle: () => push.list(),
    },
    {
      method: "POST",
      pattern: /^\/api\/push\/subscribe$/,
      handle: async (_m, req) => {
        const body = await readJson(req);
        const keys = body["keys"] as { p256dh?: unknown; auth?: unknown } | undefined;
        if (!keys || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") {
          throw new HttpError(400, "keys.p256dh and keys.auth are required");
        }
        return {
          id: push.subscribe({
            endpoint: str(body, "endpoint", true),
            keys: { p256dh: keys.p256dh, auth: keys.auth },
            label: str(body, "label"),
          }),
        };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/push\/unsubscribe$/,
      handle: async (_m, req) => {
        const body = await readJson(req);
        return { removed: push.unsubscribe(str(body, "endpoint", true)) };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/push\/test$/,
      handle: () => push.test(),
    },

    // --- debug ----------------------------------------------------------
    {
      // Pushes a synthetic request through the exact code path canUseTool
      // uses, so the approval loop is testable without spending tokens.
      method: "POST",
      pattern: /^\/api\/debug\/approvals\/simulate$/,
      handle: async (_m, req) => {
        if (!cfg.allowSimulate) throw new HttpError(404, "not found");
        const body = await readJson(req);
        const sessionId = str(body, "sessionId", true);
        if (!db.prepare(`SELECT 1 FROM sessions WHERE id = ?`).get(sessionId)) {
          throw new HttpError(404, "no such session");
        }
        // Intentionally not awaited: the point is that this parks, exactly as
        // a real tool call does. The caller polls /api/approvals to see it.
        void gate
          .request({
            sessionId,
            toolName: str(body, "toolName", true),
            input: (body["input"] as Record<string, unknown> | undefined) ?? {},
            title: str(body, "title"),
          })
          .catch(() => undefined);
        return { parked: true };
      },
    },
  ];

  return createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      try {
        const route = routes.find((r) => r.method === req.method && r.pattern.test(path));
        if (route) {
          send(res, 200, await route.handle(path.match(route.pattern)!, req));
          return;
        }
        if (path.startsWith("/api/")) throw new HttpError(404, `no route for ${req.method} ${path}`);
        if (req.method !== "GET" && req.method !== "HEAD") {
          throw new HttpError(405, "method not allowed");
        }
        await serveStatic(res, publicDir, path);
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        const message = err instanceof Error ? err.message : String(err);
        if (status >= 500) console.error(`[http] ${req.method} ${path} failed:`, err);
        send(res, status, { error: message });
      }
    })();
  });
}

async function serveStatic(res: ServerResponse, root: string, urlPath: string): Promise<void> {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\.]+)/, "");
  let file = resolvePath(join(root, rel || "index.html"));

  // Containment check: normalize() alone does not stop a crafted path from
  // escaping the public directory.
  if (!file.startsWith(resolvePath(root))) throw new HttpError(403, "forbidden");

  let info = await stat(file).catch(() => undefined);
  if (info?.isDirectory()) {
    file = join(file, "index.html");
    info = await stat(file).catch(() => undefined);
  }
  if (!info?.isFile()) {
    // Single-page app: unknown paths fall back to the shell so client-side
    // routes survive a hard refresh.
    file = join(resolvePath(root), "index.html");
    info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) throw new HttpError(404, "not found");
  }

  res.writeHead(200, {
    "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": info.size,
    // The service worker must never be served stale or push registration
    // silently keeps using an old handler.
    "cache-control": file.endsWith("sw.js") ? "no-cache" : "no-cache",
  });
  createReadStream(file).pipe(res);
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}
