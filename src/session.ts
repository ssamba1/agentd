import { randomUUID } from "node:crypto";
import {
  query,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
  type SessionStore,
} from "@anthropic-ai/claude-agent-sdk";
import type { Bus } from "./bus.js";
import type { Config } from "./config.js";
import { type Db, logEvent } from "./db.js";
import type { ApprovalGate } from "./gate.js";
import { type McpPolicy, selectServers } from "./mcp.js";
import { prepareWorkspace } from "./worktree.js";

/**
 * Turns discrete `POST /sessions/:id/message` calls into the async iterable the
 * SDK consumes. While this iterable stays open the session stays alive, which
 * is what makes a session a conversation rather than a one-shot task.
 */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  #pending: SDKUserMessage[] = [];
  #waiting: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  #closed = false;

  push(text: string): void {
    if (this.#closed) throw new Error("session input is closed");
    const message = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    } as unknown as SDKUserMessage;
    const waiter = this.#waiting;
    if (waiter) {
      this.#waiting = null;
      waiter({ value: message, done: false });
    } else {
      this.#pending.push(message);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const waiter = this.#waiting;
    if (waiter) {
      this.#waiting = null;
      waiter({ value: undefined as never, done: true });
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const queued = this.#pending.shift();
      if (queued) {
        yield queued;
        continue;
      }
      if (this.#closed) return;
      const next = await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
        this.#waiting = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  }
}

export interface StartSessionSpec {
  prompt: string;
  title?: string | undefined;
  cwd?: string | undefined;
  repo?: string | undefined;
  branch?: string | undefined;
  /** Subset of the configured MCP allowlist; omit for all of it. */
  mcpServers?: string[] | undefined;
}

interface LiveSession {
  id: string;
  abort: AbortController;
  input: InputQueue;
}

export class SessionManager {
  readonly #db: Db;
  readonly #cfg: Config;
  readonly #gate: ApprovalGate;
  readonly #bus: Bus;
  readonly #store: SessionStore;
  readonly #mcp: McpPolicy;
  readonly #live = new Map<string, LiveSession>();
  #stopping = false;

  constructor(
    db: Db,
    cfg: Config,
    gate: ApprovalGate,
    bus: Bus,
    store: SessionStore,
    mcp: McpPolicy,
  ) {
    this.#db = db;
    this.#cfg = cfg;
    this.#gate = gate;
    this.#bus = bus;
    this.#store = store;
    this.#mcp = mcp;
  }

  async start(spec: StartSessionSpec): Promise<string> {
    const id = randomUUID();
    const now = Date.now();
    // Validate the MCP selection before doing anything with side effects, so a
    // typo does not leave an orphaned worktree behind.
    selectServers(this.#mcp, spec.mcpServers);
    const workspace = await prepareWorkspace({
      repo: spec.repo,
      branch: spec.branch,
      fallbackDir: spec.cwd ?? `${this.#cfg.workRoot}/${id}`,
      sessionId: id,
    });

    this.#db
      .prepare(
        `INSERT INTO sessions
           (id, sdk_session_id, title, cwd, prompt, status, error, created_at, updated_at,
            repo, branch, worktree, project_key, mcp_servers)
         VALUES (?, NULL, ?, ?, ?, 'starting', NULL, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        id,
        spec.title ?? spec.prompt.slice(0, 80),
        workspace.cwd,
        spec.prompt,
        now,
        now,
        workspace.repo,
        workspace.branch,
        workspace.isWorktree ? 1 : 0,
        spec.mcpServers ? JSON.stringify(spec.mcpServers) : null,
      );

    this.#bus.emit("session.created", id, { title: spec.title ?? spec.prompt.slice(0, 80) });
    this.#launch(id, workspace.cwd, spec.prompt, undefined, spec.mcpServers);
    return id;
  }

  /**
   * Restart a session that a crash or restart killed, replaying its transcript
   * from the SessionStore. The cwd must be the one it originally ran in: the
   * SDK derives the store's projectKey from cwd, so a different directory
   * silently looks like a different session.
   */
  resume(id: string, prompt: string): void {
    const row = this.#db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as
      | { id: string; cwd: string; sdk_session_id: string | null; mcp_servers: string | null }
      | undefined;
    if (!row) throw new Error("no such session");
    if (this.#live.has(id)) throw new Error("session is already running");
    if (!row.sdk_session_id) throw new Error("session has no transcript to resume from");
    const mcpServers = row.mcp_servers ? (JSON.parse(row.mcp_servers) as string[]) : undefined;
    this.#launch(id, row.cwd, prompt, row.sdk_session_id, mcpServers);
  }

  #launch(
    id: string,
    cwd: string,
    prompt: string,
    resumeFrom: string | undefined,
    mcpServers: string[] | undefined,
  ): void {
    const abort = new AbortController();
    const input = new InputQueue();
    this.#live.set(id, { id, abort, input });
    input.push(prompt);
    void this.#run(id, cwd, input, abort, resumeFrom, mcpServers);
  }

  async #run(
    id: string,
    cwd: string,
    input: InputQueue,
    abort: AbortController,
    resumeFrom: string | undefined,
    mcpServers: string[] | undefined,
  ): Promise<void> {
    const mcp = selectServers(this.#mcp, mcpServers);
    const options: Options = {
      cwd,
      abortController: abort,
      sessionStore: this.#store,

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

      // With an allowlist configured, strictMcpConfig makes the SDK ignore
      // project .mcp.json, user settings, plugins and agent frontmatter, so a
      // session starts only the servers it was granted. settingSources still
      // loads CLAUDE.md, skills and commands -- the half worth inheriting.
      ...(mcp.strict ? { mcpServers: mcp.servers, strictMcpConfig: true } : {}),

      maxTurns: this.#cfg.maxTurns,
      ...(this.#cfg.model ? { model: this.#cfg.model } : {}),
      ...(resumeFrom ? { resume: resumeFrom } : {}),

      canUseTool: async (toolName, toolInput, opts) =>
        this.#gate.request({
          sessionId: id,
          toolName,
          input: toolInput,
          toolUseId: opts.toolUseID,
          title: opts.title,
          displayName: opts.displayName,
          description: opts.description,
          blockedPath: opts.blockedPath,
          decisionReason: opts.decisionReason,
          signal: opts.signal,
        }),
    };

    // Clear any error from a previous run: this session is alive again.
    this.#setStatus(id, "running", undefined, true);
    try {
      for await (const message of query({ prompt: input, options })) {
        this.#record(id, message);
      }
      this.#setStatus(id, "completed");
      this.#bus.emit("session.completed", id);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      // The child is in agentd's process group, so on shutdown it takes the
      // signal before our abort fires and the SDK reports a plain non-zero
      // exit. Without #stopping that gets filed as a genuine failure, which
      // then survives in the UI as a red session nobody actually broke.
      const interrupted = abort.signal.aborted || this.#stopping || /code 143|SIGTERM/.test(text);
      this.#setStatus(id, interrupted ? "interrupted" : "failed", text);
      logEvent(this.#db, id, interrupted ? "session.interrupted" : "session.failed", { error: text });
      this.#bus.emit(interrupted ? "session.interrupted" : "session.failed", id, { error: text });
    } finally {
      input.close();
      this.#live.delete(id);
    }
  }

  #record(id: string, message: SDKMessage): void {
    const sdkSessionId =
      "session_id" in message ? (message as { session_id?: string }).session_id : undefined;
    if (sdkSessionId) {
      this.#db
        .prepare(
          `UPDATE sessions SET sdk_session_id = ?, updated_at = ?
            WHERE id = ? AND (sdk_session_id IS NULL OR sdk_session_id != ?)`,
        )
        .run(sdkSessionId, Date.now(), id, sdkSessionId);
    }

    // Transcript mirroring is best-effort: on repeated failure the SDK drops
    // the batch and emits this. Silence here would mean losing the ability to
    // resume without ever being told.
    if (message.type === "system" && (message as { subtype?: string }).subtype === "mirror_error") {
      const err = (message as { error?: string }).error ?? "unknown";
      console.error(`[session ${id}] transcript mirror failed, batch dropped: ${err}`);
      this.#bus.emit("session.mirror_error", id, { error: err });
    }

    const seq = logEvent(this.#db, id, `sdk.${message.type}`, message);

    // A result message ends a turn. The session is not over -- it is waiting
    // for the operator's next message -- so surface it as idle, not completed.
    if (message.type === "result") {
      this.#setStatus(id, "idle");
      this.#bus.emit("session.idle", id, { seq }, seq);
    } else {
      this.#bus.emit(`sdk.${message.type}`, id, { seq }, seq);
    }
  }

  /**
   * `clearError` exists because COALESCE(?, error) alone can only ever add an
   * error, never retract one -- a resumed session would keep displaying the
   * failure that killed its previous run.
   */
  #setStatus(id: string, status: string, error?: string, clearError = false): void {
    this.#db
      .prepare(
        clearError
          ? `UPDATE sessions SET status = ?, error = NULL, updated_at = ? WHERE id = ?`
          : `UPDATE sessions SET status = ?, error = COALESCE(?, error), updated_at = ? WHERE id = ?`,
      )
      .run(...(clearError ? [status, Date.now(), id] : [status, error ?? null, Date.now(), id]));
  }

  send(id: string, text: string): boolean {
    const live = this.#live.get(id);
    if (!live || live.input.closed) return false;
    live.input.push(text);
    this.#setStatus(id, "running");
    this.#bus.emit("session.input", id, { text });
    return true;
  }

  /** Close the input stream so the session finishes cleanly after this turn. */
  end(id: string): boolean {
    const live = this.#live.get(id);
    if (!live) return false;
    live.input.close();
    return true;
  }

  interrupt(id: string): boolean {
    const live = this.#live.get(id);
    if (!live) return false;
    live.abort.abort();
    return true;
  }

  isLive(id: string): boolean {
    return this.#live.has(id);
  }

  get liveCount(): number {
    return this.#live.size;
  }

  shutdown(): void {
    // Set before aborting so in-flight catch blocks classify correctly.
    this.#stopping = true;
    for (const live of this.#live.values()) live.abort.abort();
  }
}
