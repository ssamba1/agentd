import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Credentials that outrank CLAUDE_CODE_OAUTH_TOKEN in Claude Code's
 * authentication precedence. If any of these are present, the subprocess
 * silently authenticates with them instead of the subscription token --
 * which for ANTHROPIC_API_KEY means per-token API billing.
 *
 * Precedence (docs: /docs/en/authentication#authentication-precedence):
 *   1. CLAUDE_CODE_USE_BEDROCK / _VERTEX / _FOUNDRY
 *   2. ANTHROPIC_AUTH_TOKEN
 *   3. ANTHROPIC_API_KEY
 *   4. apiKeyHelper
 *   5. CLAUDE_CODE_OAUTH_TOKEN   <-- what agentd runs on
 *   6. Anthropic profile / federation
 *   7. /login subscription credentials
 */
const OUTRANKING_CREDENTIAL_VARS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
] as const;

/**
 * Profile/federation variables rank *below* the OAuth token, so they cannot
 * hijack billing, but a stale one is still a surprising credential to have
 * lying around on an unattended box. Warn, don't fail.
 */
const SHADOWING_PROFILE_VARS = [
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
] as const;

export class CredentialEnvironmentError extends Error {
  override readonly name = "CredentialEnvironmentError";
}

/**
 * Path to stored `/login` credentials, if the host has any. Claude Code keeps
 * these under CLAUDE_CONFIG_DIR when set, otherwise ~/.claude.
 */
function storedLoginCredentialPath(env: NodeJS.ProcessEnv): string | undefined {
  const dir = env["CLAUDE_CONFIG_DIR"] ?? `${homedir()}/.claude`;
  const path = resolve(dir, ".credentials.json");
  return existsSync(path) ? path : undefined;
}

export interface CredentialAudit {
  tokenPresent: boolean;
  warnings: string[];
}

/**
 * Fail-fast credential audit. Runs before any session can start.
 *
 * This is the assertion that keeps a stray ANTHROPIC_API_KEY in a .env from
 * silently moving every session onto metered API billing.
 */
export function auditCredentialEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  { requireToken = true }: { requireToken?: boolean } = {},
): CredentialAudit {
  const offenders = OUTRANKING_CREDENTIAL_VARS.filter((k) => {
    const v = env[k];
    return typeof v === "string" && v.length > 0;
  });

  if (offenders.length > 0) {
    throw new CredentialEnvironmentError(
      `Refusing to start: ${offenders.join(", ")} set in agentd's environment. ` +
        `These outrank CLAUDE_CODE_OAUTH_TOKEN, so sessions would authenticate ` +
        `with them instead of your subscription (ANTHROPIC_API_KEY means metered ` +
        `API billing). Unset them, or remove them from the systemd EnvironmentFile.`,
    );
  }

  const tokenPresent = typeof env["CLAUDE_CODE_OAUTH_TOKEN"] === "string" &&
    env["CLAUDE_CODE_OAUTH_TOKEN"]!.length > 0;

  if (!tokenPresent && requireToken) {
    throw new CredentialEnvironmentError(
      `Refusing to start: CLAUDE_CODE_OAUTH_TOKEN is not set. Mint one with ` +
        `\`claude setup-token\` on a machine with a browser, then put it in ` +
        `/etc/agentd/claude.env (chmod 600). Set AGENTD_ALLOW_SIMULATE=1 to run ` +
        `without it for approval-loop testing.`,
    );
  }

  const warnings: string[] = [];
  if (!tokenPresent) {
    // Absent the token, the subprocess does not fail -- it falls through to
    // stored /login credentials (precedence rank 7) if the host has any, and
    // runs on those instead. Same subscription, but a different credential
    // than the one this deployment was configured for, chosen silently.
    const storedLogin = storedLoginCredentialPath(env);
    warnings.push(
      storedLogin
        ? `CLAUDE_CODE_OAUTH_TOKEN is not set, but stored /login credentials exist at ` +
          `${storedLogin}. Sessions will silently run on those instead. Set the token, ` +
          `or delete that file if you meant to run on the token alone.`
        : "CLAUDE_CODE_OAUTH_TOKEN is not set and no stored login was found; real " +
          "sessions will fail to authenticate. Simulated approvals still work.",
    );
  }
  for (const k of SHADOWING_PROFILE_VARS) {
    if (env[k]) {
      warnings.push(
        `${k} is set. It ranks below the OAuth token so billing is unaffected, ` +
          `but it is an unexpected credential on an unattended host.`,
      );
    }
  }
  return { tokenPresent, warnings };
}

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  workRoot: string;
  /** How long a pending approval waits before it is auto-denied. */
  approvalTtlMs: number;
  /** Enables POST /debug/approvals/simulate and relaxes the token requirement. */
  allowSimulate: boolean;
  /** Passed through to the SDK; undefined means the Claude Code default. */
  model: string | undefined;
  /** Hard ceiling on agentic turns per session. */
  maxTurns: number;
  /** Directory the PWA is served from. */
  publicDir: string;
  /** VAPID `sub` claim. Must be a mailto: or https: URL. */
  pushContact: string;
}

function intFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CredentialEnvironmentError(`${key} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const allowSimulate = env["AGENTD_ALLOW_SIMULATE"] === "1";
  return {
    // Loopback by default. Tailscale Serve fronts this; agentd never binds
    // a public interface itself.
    host: env["AGENTD_HOST"] ?? "127.0.0.1",
    port: intFromEnv(env, "AGENTD_PORT", 8787),
    dbPath: resolve(env["AGENTD_DB"] ?? `${homedir()}/.agentd/agentd.db`),
    workRoot: resolve(env["AGENTD_WORK_ROOT"] ?? `${homedir()}/.agentd/work`),
    approvalTtlMs: intFromEnv(env, "AGENTD_APPROVAL_TTL_SEC", 1800) * 1000,
    allowSimulate,
    model: env["AGENTD_MODEL"] || undefined,
    maxTurns: intFromEnv(env, "AGENTD_MAX_TURNS", 200),
    publicDir: resolve(env["AGENTD_PUBLIC_DIR"] ?? fileURLToPath(new URL("../public", import.meta.url))),
    pushContact: env["AGENTD_PUSH_CONTACT"] ?? "mailto:agentd@localhost",
  };
}
