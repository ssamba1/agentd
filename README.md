# agentd

Self-hosted Claude Code control plane. Runs on a box you own, keeps sessions
alive without your laptop, and turns every permission prompt into a queued
approval you can answer from anywhere instead of a prompt that silently
freezes a session until you get back to your desk.

This is the Phase 1 skeleton: the approval loop, end to end. No PWA, no push,
no worktrees, no terminal pane yet.

## Why the permission wiring looks like this

Sessions run with `permissionMode: 'default'` and an **empty** `allowedTools`.

That is deliberate and it is the whole design. Claude Code evaluates
permissions in a fixed order — hooks, deny rules, ask rules, permission mode,
allow rules, then `canUseTool`. Anything approved at an earlier step never
reaches the callback. Putting standing rules in `allowedTools` would therefore
make those tools invisible to the approval queue *and* freeze the rule set at
`query()` construction.

Empty allowlist means every tool call falls all the way through to
`canUseTool`, where the `rules` table in SQLite decides. Rules stay editable at
runtime, and the queue sees everything.

`main.ts` treats the SDK's `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning as fatal.
If that ever fires, tool calls are bypassing the gate.

## Approvals never hang forever

From the SDK's own type definitions:

> Fail-closed: an accidental null means no control_response is sent and the
> tool stays blocked indefinitely — **permission prompts have no park deadline.**

Nothing upstream times these out, so agentd does:

- Every pending approval gets `AGENTD_APPROVAL_TTL_SEC` (default 1800) and is
  auto-denied after it, with a message telling Claude to ask again.
- `SIGTERM` denies every parked approval before exit, so no subprocess is left
  blocked on a promise that will never settle.
- Approvals still `pending` at startup are leftovers from a crash — their
  promises died with the process — so they are retired to `abandoned`.
- `ApprovalGate.request()` is contractually guaranteed to settle.

## Standing rules

An inbox that asks about every `Read` gets ignored within a day, so resolving
an approval can create a rule in the same call:

```bash
curl -XPOST localhost:8787/approvals/$ID/resolve -H 'content-type: application/json' -d '{
  "decision": "allow",
  "remember": { "scope": "global", "matchKind": "prefix", "matchValue": "git " }
}'
```

Rules match on the tool's *primary input field* (`Bash`→`command`,
`Read`/`Edit`/`Write`→`file_path`, `Grep`/`Glob`→`pattern`, …) so
`Bash` + `prefix` + `git ` expresses what a person would actually write.
Session-scoped rules are considered before global ones, and within a scope a
`deny` beats an `allow`.

## Setup

```bash
npm install && npm run build

# On a machine with a browser:
claude setup-token          # prints a one-year token; it is saved nowhere

export CLAUDE_CODE_OAUTH_TOKEN=<token>
npm start
```

`deploy/agentd.service` is the systemd unit. Put the token in
`/etc/agentd/claude.env` (mode 0640, root-owned) and nowhere else.

### agentd refuses to start if the environment can bill you

Claude Code's credential precedence puts `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, and the `CLAUDE_CODE_USE_*` provider flags **above**
`CLAUDE_CODE_OAUTH_TOKEN`. A stray API key in a `.env` would silently move
every session onto metered API billing. So the credential audit runs before
anything opens a socket, and exits `78` (`EX_CONFIG`) rather than starting.

It also warns — but does not fail — when the token is missing while stored
`/login` credentials exist on the host, because the subprocess will quietly
run on those instead of the credential you configured.

## HTTP API

Binds `127.0.0.1` by default and has **no authentication of its own**. Tailscale
is the perimeter: front it with `tailscale serve` and never expose it via
Funnel, which is public.

| Method | Path | |
|---|---|---|
| GET | `/health` | uptime, live sessions, parked approvals |
| GET/POST | `/sessions` | list / start (`{prompt, cwd?, title?}`) |
| GET | `/sessions/:id` | one session |
| POST | `/sessions/:id/interrupt` | abort a running session |
| GET | `/approvals?status=` | `pending` (default), `allowed`, `denied`, `expired`, `abandoned` |
| GET | `/approvals/:id` | one approval |
| POST | `/approvals/:id/resolve` | `{decision, message?, remember?}` |
| GET/POST | `/rules` | list / create |
| DELETE | `/rules/:id` | remove |
| GET | `/events?session=&after=` | append-only session event log |
| POST | `/debug/approvals/simulate` | 404 unless `AGENTD_ALLOW_SIMULATE=1` |

## Configuration

| Variable | Default | |
|---|---|---|
| `AGENTD_HOST` | `127.0.0.1` | never bind this publicly |
| `AGENTD_PORT` | `8787` | |
| `AGENTD_DB` | `~/.agentd/agentd.db` | |
| `AGENTD_WORK_ROOT` | `~/.agentd/work` | per-session cwd when none is given |
| `AGENTD_APPROVAL_TTL_SEC` | `1800` | pending approval lifetime |
| `AGENTD_MAX_TURNS` | `200` | sessions have no timeout of their own |
| `AGENTD_MODEL` | — | Claude Code default when unset |
| `AGENTD_ALLOW_SIMULATE` | — | `1` enables the simulate route |

## Tests

```bash
npm run build && bash test/smoke.sh
```

22 assertions covering the boot audit, park/resolve, rule auto-approval, TTL
expiry, restart reaping, and the simulate route's default-off behaviour. The
simulate endpoint drives `ApprovalGate.request()` — the same function
`canUseTool` calls — so the tested path is the real one, with no credential
required and no tokens spent.

Verified separately against a live session: a real `Bash` call parked on
`canUseTool`, surfaced in `/approvals` with the SDK's own `toolUseID` and
`displayName`, was resolved over curl, and the session ran to completion.

## Known gaps

- **Single-turn sessions.** `POST /sessions` takes one prompt. Multi-turn needs
  the async-iterable prompt form and `streamInput()`.
- **No restart resume.** Transcripts are local to the container. Surviving a
  restart needs a `SessionStore` adapter plus `options.resume`.
- **No auth.** Deliberate — Tailscale is the perimeter and this is single-user.
  Anything multi-user needs a real authn layer first.
- **`title` is not always populated** by the bridge; `displayName` was set and
  `title` null in live testing, so any UI must fall back to
  `title → description → toolName + primary input`.
- **Per-session MCP allowlist.** Every session is its own subprocess with its
  own MCP servers. Heavy servers × parallel sessions will exhaust the box.
