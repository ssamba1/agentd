import { randomUUID } from "node:crypto";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { type Db, logEvent } from "./db.js";

export interface ApprovalRequest {
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string | undefined;
  title?: string | undefined;
  displayName?: string | undefined;
  description?: string | undefined;
  blockedPath?: string | undefined;
  decisionReason?: string | undefined;
  signal?: AbortSignal | undefined;
}

export type RuleAction = "allow" | "deny";
export type MatchKind = "any" | "prefix" | "exact";

export interface RuleRow {
  id: string;
  session_id: string | null;
  tool_name: string;
  match_kind: MatchKind;
  match_value: string | null;
  action: RuleAction;
  note: string | null;
  hits: number;
  created_at: number;
}

export interface RememberSpec {
  scope: "session" | "global";
  matchKind: MatchKind;
  /** Defaults to the request's primary input field when omitted. */
  matchValue?: string | undefined;
  note?: string | undefined;
}

/**
 * The field a standing rule matches against, per tool. Picking one field
 * rather than the whole input blob is what makes `Bash(git status*)` express
 * something a person would actually write.
 */
const PRIMARY_INPUT_FIELD: Record<string, string> = {
  Bash: "command",
  BashOutput: "bash_id",
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  NotebookEdit: "notebook_path",
  Glob: "pattern",
  Grep: "pattern",
  WebFetch: "url",
  WebSearch: "query",
  Task: "description",
};

export function primaryInput(toolName: string, input: Record<string, unknown>): string {
  const field = PRIMARY_INPUT_FIELD[toolName];
  if (field !== undefined) {
    const value = input[field];
    if (typeof value === "string") return value;
  }
  // MCP tools and anything unmapped: match on the serialized input so an
  // 'exact' rule is still expressible, and 'any' still works.
  try {
    return JSON.stringify(input);
  } catch {
    return "";
  }
}

function ruleMatches(rule: RuleRow, toolName: string, subject: string): boolean {
  if (rule.tool_name !== "*" && rule.tool_name !== toolName) return false;
  switch (rule.match_kind) {
    case "any":
      return true;
    case "prefix":
      return rule.match_value !== null && subject.startsWith(rule.match_value);
    case "exact":
      return rule.match_value !== null && subject === rule.match_value;
    default:
      return false;
  }
}

interface Waiter {
  approvalId: string;
  settle: (result: PermissionResult) => void;
  timer: NodeJS.Timeout;
}

export type GateListener = (event: { kind: string; approvalId: string; sessionId: string }) => void;

export class ApprovalGate {
  readonly #db: Db;
  readonly #ttlMs: number;
  readonly #waiters = new Map<string, Waiter>();
  readonly #listeners = new Set<GateListener>();
  #closed = false;

  constructor(db: Db, ttlMs: number) {
    this.#db = db;
    this.#ttlMs = ttlMs;
  }

  onEvent(listener: GateListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(kind: string, approvalId: string, sessionId: string): void {
    for (const l of this.#listeners) {
      try {
        l({ kind, approvalId, sessionId });
      } catch {
        // A bad listener must never wedge a permission decision.
      }
    }
  }

  #matchRule(sessionId: string, toolName: string, subject: string): RuleRow | undefined {
    // Session-scoped rules are considered before global ones, and within each
    // scope a deny beats an allow -- mirroring Claude Code's own ordering,
    // where deny rules are evaluated before anything can approve.
    const rules = this.#db
      .prepare(
        `SELECT * FROM rules
          WHERE (session_id = ? OR session_id IS NULL)
            AND (tool_name = ? OR tool_name = '*')
          ORDER BY (session_id IS NULL) ASC,
                   (action = 'deny') DESC,
                   created_at ASC`,
      )
      .all(sessionId, toolName) as RuleRow[];
    return rules.find((r) => ruleMatches(r, toolName, subject));
  }

  /**
   * The single entry point for every permission decision. `canUseTool` calls
   * this, and so does the simulate endpoint, so the tested path and the real
   * path are the same code.
   *
   * Contract: this promise ALWAYS settles. The SDK parks the tool call on it
   * with no deadline of its own -- a promise that never resolves blocks that
   * session's subprocess forever.
   */
  async request(req: ApprovalRequest): Promise<PermissionResult> {
    const now = Date.now();
    const id = randomUUID();
    const subject = primaryInput(req.toolName, req.input);

    const insert = this.#db.prepare(
      `INSERT INTO approvals (
         id, session_id, tool_use_id, tool_name, input_json,
         title, display_name, description, blocked_path, decision_reason,
         status, decided_by, decided_rule_id, deny_message,
         created_at, expires_at, decided_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );

    const rule = this.#closed ? undefined : this.#matchRule(req.sessionId, req.toolName, subject);

    if (rule) {
      const status = rule.action === "allow" ? "allowed" : "denied";
      const denyMessage =
        rule.action === "deny"
          ? `Denied by standing rule ${rule.id}${rule.note ? `: ${rule.note}` : ""}`
          : null;
      insert.run(
        id, req.sessionId, req.toolUseId ?? null, req.toolName, JSON.stringify(req.input),
        req.title ?? null, req.displayName ?? null, req.description ?? null,
        req.blockedPath ?? null, req.decisionReason ?? null,
        status, "rule", rule.id, denyMessage,
        now, null, now,
      );
      this.#db.prepare(`UPDATE rules SET hits = hits + 1 WHERE id = ?`).run(rule.id);
      this.#emit("approval.auto", id, req.sessionId);
      return rule.action === "allow"
        ? { behavior: "allow", updatedInput: req.input }
        : { behavior: "deny", message: denyMessage! };
    }

    // Shutting down: fail closed rather than parking a call nobody can answer.
    if (this.#closed) {
      insert.run(
        id, req.sessionId, req.toolUseId ?? null, req.toolName, JSON.stringify(req.input),
        req.title ?? null, req.displayName ?? null, req.description ?? null,
        req.blockedPath ?? null, req.decisionReason ?? null,
        "denied", "shutdown", null, "agentd is shutting down",
        now, null, now,
      );
      return { behavior: "deny", message: "agentd is shutting down" };
    }

    const expiresAt = now + this.#ttlMs;
    insert.run(
      id, req.sessionId, req.toolUseId ?? null, req.toolName, JSON.stringify(req.input),
      req.title ?? null, req.displayName ?? null, req.description ?? null,
      req.blockedPath ?? null, req.decisionReason ?? null,
      "pending", null, null, null,
      now, expiresAt, null,
    );
    logEvent(this.#db, req.sessionId, "approval.pending", {
      approvalId: id, toolName: req.toolName, subject,
    });
    this.#emit("approval.pending", id, req.sessionId);

    return new Promise<PermissionResult>((resolvePromise) => {
      let settled = false;
      const abortHandler = (): void => {
        this.#finalize(id, "abandoned", "abort", "Session aborted while awaiting approval");
        this.#emit("approval.aborted", id, req.sessionId);
        settle({ behavior: "deny", message: "Session aborted while awaiting approval" });
      };

      const settle = (result: PermissionResult): void => {
        if (settled) return;
        settled = true;
        const waiter = this.#waiters.get(id);
        if (waiter) clearTimeout(waiter.timer);
        this.#waiters.delete(id);
        req.signal?.removeEventListener("abort", abortHandler);
        resolvePromise(result);
      };

      const timer = setTimeout(() => {
        this.#finalize(id, "expired", "timeout", `No response within ${Math.round(this.#ttlMs / 1000)}s`);
        this.#emit("approval.expired", id, req.sessionId);
        settle({
          behavior: "deny",
          message:
            `Auto-denied: no approval within ${Math.round(this.#ttlMs / 1000)}s. ` +
            `Ask again if this is still needed.`,
        });
      }, this.#ttlMs);

      this.#waiters.set(id, { approvalId: id, settle, timer });

      if (req.signal) {
        if (req.signal.aborted) {
          abortHandler();
        } else {
          req.signal.addEventListener("abort", abortHandler, { once: true });
        }
      }
    });
  }

  #finalize(
    id: string,
    status: "allowed" | "denied" | "expired" | "abandoned",
    decidedBy: "user" | "timeout" | "abort" | "shutdown",
    denyMessage: string | null,
    ruleId: string | null = null,
  ): void {
    this.#db
      .prepare(
        `UPDATE approvals
            SET status = ?, decided_by = ?, decided_at = ?, deny_message = ?,
                decided_rule_id = COALESCE(?, decided_rule_id)
          WHERE id = ? AND status = 'pending'`,
      )
      .run(status, decidedBy, Date.now(), denyMessage, ruleId, id);
  }

  /**
   * Resolve a pending approval from the outside (the HTTP API, and later the
   * PWA). Returns false when the approval is unknown or already decided --
   * which is the common case after a TTL expiry, so callers should treat it
   * as "too late", not as an error.
   */
  decide(
    id: string,
    decision: "allow" | "deny",
    opts: { message?: string | undefined; remember?: RememberSpec | undefined } = {},
  ): { ok: boolean; reason?: string; ruleId?: string } {
    const row = this.#db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id) as
      | { id: string; session_id: string; status: string; tool_name: string; input_json: string }
      | undefined;
    if (!row) return { ok: false, reason: "no such approval" };
    if (row.status !== "pending") return { ok: false, reason: `already ${row.status}` };

    let ruleId: string | undefined;
    if (opts.remember) {
      const input = JSON.parse(row.input_json) as Record<string, unknown>;
      ruleId = this.addRule({
        sessionId: opts.remember.scope === "session" ? row.session_id : null,
        toolName: row.tool_name,
        matchKind: opts.remember.matchKind,
        matchValue: opts.remember.matchValue ?? primaryInput(row.tool_name, input),
        action: decision,
        note: opts.remember.note,
      });
    }

    const denyMessage = decision === "deny" ? (opts.message ?? "Denied by operator") : null;
    this.#finalize(id, decision === "allow" ? "allowed" : "denied", "user", denyMessage, ruleId ?? null);

    const waiter = this.#waiters.get(id);
    if (waiter) {
      const input = JSON.parse(row.input_json) as Record<string, unknown>;
      waiter.settle(
        decision === "allow"
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: denyMessage! },
      );
    }
    logEvent(this.#db, row.session_id, `approval.${decision}`, { approvalId: id, ruleId });
    this.#emit(`approval.${decision}`, id, row.session_id);
    return ruleId ? { ok: true, ruleId } : { ok: true };
  }

  addRule(spec: {
    sessionId: string | null;
    toolName: string;
    matchKind: MatchKind;
    matchValue: string | null;
    action: RuleAction;
    note?: string | undefined;
  }): string {
    const id = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO rules (id, session_id, tool_name, match_kind, match_value, action, note, hits, created_at)
         VALUES (?,?,?,?,?,?,?,0,?)`,
      )
      .run(
        id,
        spec.sessionId,
        spec.toolName,
        spec.matchKind,
        spec.matchKind === "any" ? null : spec.matchValue,
        spec.action,
        spec.note ?? null,
        Date.now(),
      );
    return id;
  }

  /** Deny everything still parked, so no subprocess is left waiting on exit. */
  shutdown(): number {
    this.#closed = true;
    const waiters = [...this.#waiters.values()];
    for (const w of waiters) {
      this.#finalize(w.approvalId, "abandoned", "shutdown", "agentd is shutting down");
      w.settle({ behavior: "deny", message: "agentd is shutting down" });
    }
    return waiters.length;
  }

  get pendingCount(): number {
    return this.#waiters.size;
  }
}
