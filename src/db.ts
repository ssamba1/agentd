import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database.Database;

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE sessions (
  id             TEXT PRIMARY KEY,
  sdk_session_id TEXT,
  title          TEXT NOT NULL,
  cwd            TEXT NOT NULL,
  prompt         TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN
                   ('starting','running','completed','failed','interrupted')),
  error          TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX sessions_status_idx ON sessions(status, created_at DESC);

-- One row per permission decision, whether a rule made it or a human did.
-- Rows are never deleted: this table is the audit log of everything the
-- agent was allowed to do.
CREATE TABLE approvals (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  tool_use_id     TEXT,
  tool_name       TEXT NOT NULL,
  input_json      TEXT NOT NULL,
  -- Presentation metadata handed to us by the SDK. Render the inbox from
  -- these rather than reconstructing prompt text from tool_name + input.
  title           TEXT,
  display_name    TEXT,
  description     TEXT,
  blocked_path    TEXT,
  decision_reason TEXT,
  status          TEXT NOT NULL CHECK (status IN
                    ('pending','allowed','denied','expired','abandoned')),
  decided_by      TEXT CHECK (decided_by IN ('rule','user','timeout','abort','shutdown')),
  decided_rule_id TEXT REFERENCES rules(id),
  deny_message    TEXT,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER,
  decided_at      INTEGER
);
CREATE INDEX approvals_pending_idx ON approvals(status, created_at);
CREATE INDEX approvals_session_idx ON approvals(session_id, created_at DESC);

-- Standing rules. These, not the SDK's allowedTools, are the source of truth
-- for auto-approval: the session runs with permissionMode 'default' and an
-- empty allowlist so that every tool call reaches canUseTool and is matched
-- here. That keeps the rules editable at runtime instead of frozen at
-- query() construction.
CREATE TABLE rules (
  id          TEXT PRIMARY KEY,
  -- NULL scope means the rule applies to every session.
  session_id  TEXT REFERENCES sessions(id),
  tool_name   TEXT NOT NULL,
  match_kind  TEXT NOT NULL CHECK (match_kind IN ('any','prefix','exact')),
  match_value TEXT,
  action      TEXT NOT NULL CHECK (action IN ('allow','deny')),
  note        TEXT,
  hits        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX rules_lookup_idx ON rules(tool_name, action);

CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  ts         INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL
);
CREATE INDEX events_session_idx ON events(session_id, id);
`;

export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");

  const current = db.pragma("user_version", { simple: true }) as number;
  if (current === 0) {
    db.exec(SCHEMA);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  } else if (current !== SCHEMA_VERSION) {
    throw new Error(
      `Database at ${path} is schema version ${current}, this build expects ` +
        `${SCHEMA_VERSION}. No migration path exists yet -- move the file aside.`,
    );
  }
  return db;
}

/**
 * A pending approval means a subprocess is parked on a promise. Those promises
 * die with the process, so any row still 'pending' at startup is a leftover
 * from a crash or restart and can never be resolved. Retire them so the inbox
 * shows the truth.
 *
 * The SDK's own note on canUseTool: "permission prompts have no park deadline."
 * Nothing else cleans these up.
 */
export function reapOrphanedApprovals(db: Db, now = Date.now()): number {
  const result = db
    .prepare(
      `UPDATE approvals
          SET status = 'abandoned',
              decided_by = 'shutdown',
              decided_at = ?,
              deny_message = 'agentd restarted while this approval was pending'
        WHERE status = 'pending'`,
    )
    .run(now);
  return result.changes;
}

/**
 * Sessions are subprocesses. They do not survive a restart either. Resuming
 * them is a Phase 2 concern (SessionStore + options.resume); for now, mark
 * them honestly rather than leaving zombies in the dashboard.
 */
export function reapOrphanedSessions(db: Db, now = Date.now()): number {
  const result = db
    .prepare(
      `UPDATE sessions
          SET status = 'interrupted',
              error = COALESCE(error, 'agentd restarted while this session was running'),
              updated_at = ?
        WHERE status IN ('starting','running')`,
    )
    .run(now);
  return result.changes;
}

export function logEvent(db: Db, sessionId: string | null, kind: string, payload: unknown): void {
  db.prepare(`INSERT INTO events (session_id, ts, kind, payload) VALUES (?, ?, ?, ?)`).run(
    sessionId,
    Date.now(),
    kind,
    JSON.stringify(payload ?? null),
  );
}
