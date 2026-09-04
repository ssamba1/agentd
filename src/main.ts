import { auditCredentialEnvironment, CredentialEnvironmentError, loadConfig } from "./config.js";
import { openDb, reapOrphanedApprovals, reapOrphanedSessions } from "./db.js";
import { ApprovalGate } from "./gate.js";
import { createHttpServer } from "./http.js";
import { SessionManager } from "./session.js";

function main(): void {
  const cfg = loadConfig();

  // Credential audit runs before anything else opens a socket or a database.
  // A stray ANTHROPIC_API_KEY here means every session silently bills the API.
  const audit = auditCredentialEnvironment(process.env, { requireToken: !cfg.allowSimulate });
  for (const w of audit.warnings) console.warn(`[warn] ${w}`);

  const db = openDb(cfg.dbPath);
  const reapedApprovals = reapOrphanedApprovals(db);
  const reapedSessions = reapOrphanedSessions(db);
  if (reapedApprovals || reapedSessions) {
    console.warn(
      `[warn] retired ${reapedApprovals} orphaned approval(s) and ${reapedSessions} orphaned ` +
        `session(s) left by a previous run`,
    );
  }

  const gate = new ApprovalGate(db, cfg.approvalTtlMs);
  const sessions = new SessionManager(db, cfg, gate);
  const server = createHttpServer({ db, cfg, gate, sessions, startedAt: Date.now() });

  // The SDK warns once if canUseTool would be shadowed by the permission
  // config. We run 'default' + empty allowlist precisely so it is not, so if
  // this ever fires it means the permission wiring regressed.
  process.on("warning", (w: NodeJS.ErrnoException) => {
    if (w.code === "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED") {
      console.error(`[FATAL] ${w.code}: tool calls would bypass the approval gate. ${w.message}`);
      process.exitCode = 1;
      shutdown("shadowed-permissions");
    }
  });

  server.listen(cfg.port, cfg.host, () => {
    console.log(`[agentd] listening on http://${cfg.host}:${cfg.port}`);
    console.log(`[agentd] db=${cfg.dbPath} approvalTtl=${cfg.approvalTtlMs / 1000}s`);
    console.log(
      `[agentd] auth=${audit.tokenPresent ? "CLAUDE_CODE_OAUTH_TOKEN" : "NONE (simulate only)"}` +
        `${cfg.allowSimulate ? " simulate=on" : ""}`,
    );
  });

  let shuttingDown = false;
  function shutdown(reason: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[agentd] shutting down (${reason})`);

    // Order matters: deny parked approvals first so subprocesses unblock and
    // can exit, then abort the sessions, then close the socket and the db.
    const denied = gate.shutdown();
    if (denied) console.log(`[agentd] denied ${denied} parked approval(s)`);
    sessions.shutdown();

    server.close(() => {
      db.close();
      process.exit(process.exitCode ?? 0);
    });
    // Don't hang forever on a stuck connection.
    setTimeout(() => {
      db.close();
      process.exit(process.exitCode ?? 0);
    }, 5000).unref();
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

try {
  main();
} catch (err) {
  if (err instanceof CredentialEnvironmentError) {
    console.error(`\n[agentd] ${err.message}\n`);
    process.exit(78); // EX_CONFIG
  }
  throw err;
}
