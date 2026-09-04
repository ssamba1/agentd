import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import type { Db } from "./db.js";

/**
 * SQLite-backed SessionStore.
 *
 * The subprocess writes transcripts to local disk first and the SDK mirrors a
 * copy here; local JSONL does not survive a restart, so after one this table
 * holds the only durable copy. That is what makes `options.resume` work across
 * an agentd restart instead of losing the session.
 *
 * Contract notes the SDK spells out and this implementation honours:
 *  - `append` is called AFTER the local write succeeds, in batches at roughly
 *    100ms cadence. It must be idempotent on `uuid`, because retries and
 *    `importSessionToStore()` replays re-send entries.
 *  - Entries WITHOUT a uuid (titles, tags, mode markers) must always append.
 *    SQLite treats NULLs as distinct in a UNIQUE index, so the same
 *    INSERT OR IGNORE gives both behaviours with no branching.
 *  - `load` returns null for a key that was never written.
 *  - Returned entries need only be deep-equal to what was appended; the SDK
 *    never byte-compares them.
 */
export function createSqliteSessionStore(db: Db): SessionStore {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO session_entries
       (project_key, session_id, subpath, uuid, entry, ts)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const insertBatch = db.transaction(
    (key: SessionKey, entries: SessionStoreEntry[], now: number) => {
      for (const entry of entries) {
        insert.run(
          key.projectKey,
          key.sessionId,
          key.subpath ?? "",
          typeof entry["uuid"] === "string" ? entry["uuid"] : null,
          JSON.stringify(entry),
          now,
        );
      }
    },
  );

  return {
    async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
      if (entries.length === 0) return;
      insertBatch(key, entries, Date.now());
    },

    async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
      const rows = db
        .prepare(
          `SELECT entry FROM session_entries
            WHERE project_key = ? AND session_id = ? AND subpath = ?
            ORDER BY id`,
        )
        .all(key.projectKey, key.sessionId, key.subpath ?? "") as Array<{ entry: string }>;
      if (rows.length === 0) return null;
      return rows.map((r) => JSON.parse(r.entry) as SessionStoreEntry);
    },

    async listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>> {
      return db
        .prepare(
          `SELECT session_id AS sessionId, MAX(ts) AS mtime
             FROM session_entries
            WHERE project_key = ? AND subpath = ''
            GROUP BY session_id`,
        )
        .all(projectKey) as Array<{ sessionId: string; mtime: number }>;
    },
  };
}
