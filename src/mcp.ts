import { readFileSync } from "node:fs";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

export interface McpPolicy {
  /** Servers agentd is allowed to start, by name. Empty means "inherit". */
  servers: Record<string, McpServerConfig>;
  /** True once an explicit config exists, which switches the SDK to strict mode. */
  strict: boolean;
}

export class McpConfigError extends Error {
  override readonly name = "McpConfigError";
}

/**
 * Load the MCP allowlist.
 *
 * Every session is its own subprocess with its own MCP servers, so inheriting a
 * large user-level MCP config multiplies across parallel sessions and is the
 * fastest way to exhaust a small box. Pointing AGENTD_MCP_CONFIG at a file
 * switches the SDK to `strictMcpConfig`, which ignores project `.mcp.json`,
 * user settings, plugins and agent frontmatter -- while `settingSources` still
 * loads CLAUDE.md, skills and commands, which is the half worth keeping.
 *
 * With no config file the behaviour is unchanged: inherit everything, which is
 * the right default for one operator on one machine running one session.
 */
export function loadMcpPolicy(path: string | undefined): McpPolicy {
  if (!path) return { servers: {}, strict: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new McpConfigError(
      `AGENTD_MCP_CONFIG=${path} could not be read: ${err instanceof Error ? err.message : err}`,
    );
  }

  // Accept both a bare map and the `{ "mcpServers": { ... } }` shape that
  // .mcp.json and Claude Code settings files use, so an existing file can be
  // pointed at directly.
  const raw =
    parsed && typeof parsed === "object" && "mcpServers" in (parsed as Record<string, unknown>)
      ? (parsed as { mcpServers: unknown }).mcpServers
      : parsed;

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new McpConfigError(
      `AGENTD_MCP_CONFIG=${path} must contain an object of server definitions, ` +
        `either at the top level or under "mcpServers".`,
    );
  }

  return { servers: raw as Record<string, McpServerConfig>, strict: true };
}

/**
 * Narrow the policy to the servers a single session asked for.
 *
 * An unknown name is an error rather than a silent omission: a session that
 * quietly starts without the server it requested looks like a broken tool, not
 * a configuration mistake, and that is an expensive thing to debug remotely.
 */
export function selectServers(
  policy: McpPolicy,
  requested: string[] | undefined,
): { servers: Record<string, McpServerConfig>; strict: boolean } {
  if (!policy.strict) {
    if (requested?.length) {
      throw new McpConfigError(
        `This session requested MCP servers (${requested.join(", ")}) but agentd has no ` +
          `AGENTD_MCP_CONFIG, so it cannot restrict them. Set one to use per-session scoping.`,
      );
    }
    return { servers: {}, strict: false };
  }

  if (!requested) return { servers: policy.servers, strict: true };

  const selected: Record<string, McpServerConfig> = {};
  const unknown: string[] = [];
  for (const name of requested) {
    const cfg = policy.servers[name];
    if (cfg === undefined) unknown.push(name);
    else selected[name] = cfg;
  }
  if (unknown.length) {
    throw new McpConfigError(
      `Unknown MCP server(s): ${unknown.join(", ")}. Configured: ` +
        `${Object.keys(policy.servers).join(", ") || "(none)"}`,
    );
  }
  return { servers: selected, strict: true };
}
