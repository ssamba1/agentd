import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database.Database;

const V1 = `
CREATE TABLE sessions (
  id             TEXT PRIMARY KEY,
  sdk_session_id TEXT,
  title          TEXT NOT NULL,
  cwd            TEXT NOT NULL,
  prompt         TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN
                   ('starting','running','idle','completed','failed','interrupted')),
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
-- for auto-approval: sessions run with permissionMode 'default' and an empty
-- allowlist so every tool call reaches canUseTool and is matched here. That
-- keeps rules editable at runtime instead of frozen at query() construction.
CREATE TABLE rules (
  id          TEXT PRIMARY KEY,
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

const V2 = `
ALTER TABLE sessions ADD COLUMN repo TEXT;
ALTER TABLE sessions ADD COLUMN branch TEXT;
ALTER TABLE sessions ADD COLUMN worktree INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN project_key TEXT;

-- Durable mirror of session transcripts, written through the SDK's
-- SessionStore interface. Local JSONL dies with the container; this is what
-- options.resume reads back after a restart.
CREATE TABLE session_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_key TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  subpath     TEXT NOT NULL DEFAULT '',
  uuid        TEXT,
  entry       TEXT NOT NULL,
  ts          INTEGER NOT NULL
);
CREATE INDEX session_entries_key_idx ON session_entries(project_key, session_id, subpath, id);
-- SQLite treats NULLs as distinct in a UNIQUE index, so entries without a
-- uuid (titles, tags, mode markers) always append while entries with one are
-- deduped. That is exactly the contract the SDK asks adapters to implement.
CREATE UNIQUE INDEX session_entries_uuid_idx
  ON session_entries(project_key, session_id, subpath, uuid);

CREATE TABLE push_subscriptions (
  id         TEXT PRIMARY KEY,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  label      TEXT,
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER,
  failures   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE app_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const MIGRATIONS: string[] = [V1, V2];
const SCHEMA_VERSION = MIGRATIONS.length;

export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");

  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `Database at ${path} is schema version ${current}, newer than this build ` +
        `(${SCHEMA_VERSION}). Downgrading is not supported.`,
    );
  }
  for (let v = current; v < SCHEMA_VERSION; v++) {
    const sql = MIGRATIONS[v]!;
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${v + 1}`);
    })();
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
  return db
    .prepare(
      `UPDATE approvals
          SET status = 'abandoned', decided_by = 'shutdown', decided_at = ?,
              deny_message = 'agentd restarted while this approval was pending'
        WHERE status = 'pending'`,
    )
    .run(now).changes;
}

/**
 * Subprocesses do not survive a restart. Sessions whose transcript was mirrored
 * to session_entries can be resumed on demand; the rest are dead. Either way
 * they are not running right now, so stop claiming they are.
 */
export function reapOrphanedSessions(db: Db, now = Date.now()): number {
  return db
    .prepare(
      `UPDATE sessions
          SET status = 'interrupted',
              error = COALESCE(error, 'agentd restarted while this session was running'),
              updated_at = ?
        WHERE status IN ('starting','running','idle')`,
    )
    .run(now).changes;
}

export function logEvent(db: Db, sessionId: string | null, kind: string, payload: unknown): number {
  return Number(
    db
      .prepare(`INSERT INTO events (session_id, ts, kind, payload) VALUES (?, ?, ?, ?)`)
      .run(sessionId, Date.now(), kind, JSON.stringify(payload ?? null)).lastInsertRowid,
  );
}

export function getConfigValue(db: Db, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM app_config WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setConfigValue(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}
