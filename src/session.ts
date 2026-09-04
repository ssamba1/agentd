import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "./config.js";
import { type Db, logEvent } from "./db.js";
import type { ApprovalGate } from "./gate.js";

export interface StartSessionSpec {
  prompt: string;
  cwd?: string | undefined;
  title?: string | undefined;
}

interface LiveSession {
  id: string;
  abort: AbortController;
}

export class SessionManager {
  readonly #db: Db;
  readonly #cfg: Config;
  readonly #gate: ApprovalGate;
  readonly #live = new Map<string, LiveSession>();

  constructor(db: Db, cfg: Config, gate: ApprovalGate) {
    this.#db = db;
    this.#cfg = cfg;
    this.#gate = gate;
  }

  start(spec: StartSessionSpec): string {
    const id = randomUUID();
    const now = Date.now();
    const cwd = spec.cwd ?? `${this.#cfg.workRoot}/${id}`;
    mkdirSync(cwd, { recursive: true });

    this.#db
      .prepare(
        `INSERT INTO sessions (id, sdk_session_id, title, cwd, prompt, status, error, created_at, updated_at)
         VALUES (?, NULL, ?, ?, ?, 'starting', NULL, ?, ?)`,
      )
      .run(id, spec.title ?? spec.prompt.slice(0, 80), cwd, spec.prompt, now, now);

    const abort = new AbortController();
    this.#live.set(id, { id, abort });

    // Deliberately not awaited: the session runs for as long as it runs, and
    // the HTTP request that started it returns immediately with the id.
    void this.#run(id, spec.prompt, cwd, abort);
    return id;
  }

  async #run(id: string, prompt: string, cwd: string, abort: AbortController): Promise<void> {
    const options: Options = {
      cwd,
      abortController: abort,

      // The whole design rests on these two lines.
      //
      // 'default' means no auto-approvals, and an empty allowlist means no
      // tool is pre-approved -- so every tool call falls through the
      // permission flow to canUseTool, where the SQLite rules table decides.
      // Putting rules in `allowedTools` instead would freeze them at
      // construction time and silently skip the callback for those tools.
      permissionMode: "default",
      allowedTools: [],

      // Single-user box: the operator's own ~/.claude (CLAUDE.md, skills,
      // agents, local MCP servers) is wanted, not isolated away.
      settingSources: ["user", "project", "local"],

      maxTurns: this.#cfg.maxTurns,
      ...(this.#cfg.model ? { model: this.#cfg.model } : {}),

      canUseTool: async (toolName, input, opts) =>
        this.#gate.request({
          sessionId: id,
          toolName,
          input,
          toolUseId: opts.toolUseID,
          title: opts.title,
          displayName: opts.displayName,
          description: opts.description,
          blockedPath: opts.blockedPath,
          decisionReason: opts.decisionReason,
          signal: opts.signal,
        }),
    };

    this.#setStatus(id, "running");
    try {
      for await (const message of query({ prompt, options })) {
        this.#record(id, message);
      }
      this.#setStatus(id, "completed");
    } catch (err) {
      const aborted = abort.signal.aborted;
      const text = err instanceof Error ? err.message : String(err);
      this.#setStatus(id, aborted ? "interrupted" : "failed", text);
      logEvent(this.#db, id, aborted ? "session.interrupted" : "session.failed", { error: text });
    } finally {
      this.#live.delete(id);
    }
  }

  #record(id: string, message: SDKMessage): void {
    const sdkSessionId = "session_id" in message ? (message as { session_id?: string }).session_id : undefined;
    if (sdkSessionId) {
      this.#db
        .prepare(`UPDATE sessions SET sdk_session_id = ?, updated_at = ? WHERE id = ? AND sdk_session_id IS NULL`)
        .run(sdkSessionId, Date.now(), id);
    }
    logEvent(this.#db, id, `sdk.${message.type}`, message);
  }

  #setStatus(id: string, status: string, error?: string): void {
    this.#db
      .prepare(`UPDATE sessions SET status = ?, error = COALESCE(?, error), updated_at = ? WHERE id = ?`)
      .run(status, error ?? null, Date.now(), id);
  }

  interrupt(id: string): boolean {
    const live = this.#live.get(id);
    if (!live) return false;
    live.abort.abort();
    return true;
  }

  get liveCount(): number {
    return this.#live.size;
  }

  shutdown(): void {
    for (const live of this.#live.values()) live.abort.abort();
  }
}
