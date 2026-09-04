import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { ApprovalGate, type MatchKind, type RememberSpec } from "./gate.js";
import type { SessionManager } from "./session.js";

const MAX_BODY_BYTES = 1_000_000;

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
  db: Db;
  cfg: Config;
  gate: ApprovalGate;
  sessions: SessionManager;
  startedAt: number;
}

export function createHttpServer(deps: HttpDeps): Server {
  const { db, cfg, gate, sessions } = deps;

  const routes: Array<{
    method: string;
    pattern: RegExp;
    handle: (m: RegExpMatchArray, req: IncomingMessage) => Promise<unknown> | unknown;
  }> = [
    {
      method: "GET",
      pattern: /^\/health$/,
      handle: () => ({
        ok: true,
        uptimeSec: Math.round((Date.now() - deps.startedAt) / 1000),
        liveSessions: sessions.liveCount,
        parkedApprovals: gate.pendingCount,
        approvalTtlSec: Math.round(cfg.approvalTtlMs / 1000),
        simulateEnabled: cfg.allowSimulate,
      }),
    },
    {
      method: "GET",
      pattern: /^\/sessions$/,
      handle: () => db.prepare(`SELECT * FROM sessions ORDER BY created_at DESC LIMIT 100`).all(),
    },
    {
      method: "POST",
      pattern: /^\/sessions$/,
      handle: async (_m, req) => {
        const body = await readJson(req);
        const id = sessions.start({
          prompt: str(body, "prompt", true),
          cwd: str(body, "cwd"),
          title: str(body, "title"),
        });
        return { id };
      },
    },
    {
      method: "GET",
      pattern: /^\/sessions\/([\w-]+)$/,
      handle: (m) => {
        const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(m[1]);
        if (!row) throw new HttpError(404, "no such session");
        return row;
      },
    },
    {
      method: "POST",
      pattern: /^\/sessions\/([\w-]+)\/interrupt$/,
      handle: (m) => {
        const ok = sessions.interrupt(m[1]!);
        if (!ok) throw new HttpError(409, "session is not running");
        return { ok: true };
      },
    },
    {
      method: "GET",
      pattern: /^\/approvals$/,
      handle: (_m, req) => {
        const url = new URL(req.url!, "http://localhost");
        const status = url.searchParams.get("status") ?? "pending";
        return db
          .prepare(`SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT 200`)
          .all(status);
      },
    },
    {
      method: "GET",
      pattern: /^\/approvals\/([\w-]+)$/,
      handle: (m) => {
        const row = db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(m[1]);
        if (!row) throw new HttpError(404, "no such approval");
        return row;
      },
    },
    {
      method: "POST",
      pattern: /^\/approvals\/([\w-]+)\/resolve$/,
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
    {
      method: "GET",
      pattern: /^\/rules$/,
      handle: () => db.prepare(`SELECT * FROM rules ORDER BY created_at DESC`).all(),
    },
    {
      method: "POST",
      pattern: /^\/rules$/,
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
        const id = gate.addRule({
          sessionId: str(body, "sessionId") ?? null,
          toolName: str(body, "toolName", true),
          matchKind,
          matchValue: matchValue ?? null,
          action,
          note: str(body, "note"),
        });
        return { id };
      },
    },
    {
      method: "DELETE",
      pattern: /^\/rules\/([\w-]+)$/,
      handle: (m) => {
        const res = db.prepare(`DELETE FROM rules WHERE id = ?`).run(m[1]);
        if (res.changes === 0) throw new HttpError(404, "no such rule");
        return { ok: true };
      },
    },
    {
      method: "GET",
      pattern: /^\/events$/,
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
    {
      // Pushes a synthetic request through the exact code path canUseTool
      // uses, so the approval loop is testable without spending tokens.
      method: "POST",
      pattern: /^\/debug\/approvals\/simulate$/,
      handle: async (_m, req) => {
        if (!cfg.allowSimulate) throw new HttpError(404, "not found");
        const body = await readJson(req);
        const sessionId = str(body, "sessionId", true);
        const exists = db.prepare(`SELECT 1 FROM sessions WHERE id = ?`).get(sessionId);
        if (!exists) throw new HttpError(404, "no such session");
        const toolName = str(body, "toolName", true);
        const input = (body["input"] as Record<string, unknown> | undefined) ?? {};
        // Intentionally not awaited: the point is that this parks, exactly as
        // a real tool call does. The caller polls /approvals to see it.
        const settled = gate.request({ sessionId, toolName, input, title: str(body, "title") });
        void settled.catch(() => undefined);
        return { parked: true };
      },
    },
  ];

  return createServer((req, res) => {
    void (async () => {
      const started = Date.now();
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      try {
        const route = routes.find((r) => r.method === req.method && r.pattern.test(path));
        if (!route) throw new HttpError(404, `no route for ${req.method} ${path}`);
        const match = path.match(route.pattern)!;
        const payload = await route.handle(match, req);
        send(res, 200, payload);
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        const message = err instanceof Error ? err.message : String(err);
        if (status >= 500) console.error(`[http] ${req.method} ${path} failed:`, err);
        send(res, status, { error: message });
      } finally {
        console.log(`[http] ${req.method} ${path} ${Date.now() - started}ms`);
      }
    })();
  });
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}
