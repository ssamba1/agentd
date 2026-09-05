import type { Duplex } from "node:stream";
import { Bus } from "./bus.js";
import { auditCredentialEnvironment, CredentialEnvironmentError, loadConfig } from "./config.js";
import { openDb, reapOrphanedApprovals, reapOrphanedSessions } from "./db.js";
import { ApprovalGate } from "./gate.js";
import { createHttpServer } from "./http.js";
import { loadMcpPolicy, McpConfigError } from "./mcp.js";
import { createPtySocket } from "./pty.js";
import { PushService } from "./push.js";
import { SessionManager } from "./session.js";
import { createSqliteSessionStore } from "./sessionStore.js";
import { createEventSocket } from "./ws.js";

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

  const bus = new Bus();
  const gate = new ApprovalGate(db, bus, cfg.approvalTtlMs);
  const store = createSqliteSessionStore(db);
  const mcp = loadMcpPolicy(cfg.mcpConfigPath);
  const sessions = new SessionManager(db, cfg, gate, bus, store, mcp);
  const push = new PushService(db, bus, cfg.pushContact);
  const server = createHttpServer({
    db,
    cfg,
    gate,
    sessions,
    push,
    publicDir: cfg.publicDir,
    mcpNames: mcp.strict ? Object.keys(mcp.servers) : null,
    startedAt: Date.now(),
  });

  // Two WebSocket endpoints share one HTTP server, so upgrade routing is done
  // here rather than letting each WebSocketServer race for the event and
  // destroy sockets meant for the other.
  const events = createEventSocket(bus, db);
  const pty = createPtySocket(db, cfg.workRoot);

  server.on("upgrade", (req, socket: Duplex, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/ws") {
      events.handleUpgrade(req, socket, head, (ws) => events.emit("connection", ws, req));
    } else if (url.pathname === "/pty") {
      const cwd = pty.resolveCwd(url.searchParams.get("session"), url.searchParams.get("cwd"));
      pty.wss.handleUpgrade(req, socket, head, (ws) => pty.wss.emit("connection", ws, req, cwd));
    } else {
      socket.destroy();
    }
  });

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
        ` push=${push.enabled ? "on" : "off"}` +
        ` mcp=${mcp.strict ? `strict(${Object.keys(mcp.servers).length})` : "inherit"}` +
        `${cfg.allowSimulate ? " simulate=on" : ""}`,
    );
  });

  let shuttingDown = false;
  function shutdown(reason: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[agentd] shutting down (${reason})`);

    // Order matters: deny parked approvals first so subprocesses unblock and
    // can exit, then abort the sessions, then close the sockets and the db.
    const denied = gate.shutdown();
    if (denied) console.log(`[agentd] denied ${denied} parked approval(s)`);
    sessions.shutdown();
    for (const client of events.clients) client.terminate();
    for (const client of pty.wss.clients) client.terminate();

    const finish = (): void => {
      db.close();
      process.exit(process.exitCode ?? 0);
    };
    server.close(finish);
    setTimeout(finish, 5000).unref();
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

try {
  main();
} catch (err) {
  if (err instanceof CredentialEnvironmentError || err instanceof McpConfigError) {
    console.error(`\n[agentd] ${err.message}\n`);
    process.exit(78); // EX_CONFIG
  }
  throw err;
}
