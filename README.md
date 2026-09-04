# agentd

Self-hosted Claude Code control plane. Runs on a box you own, keeps sessions
alive without your laptop, and turns every permission prompt into a queued
approval you can answer from anywhere instead of a prompt that silently freezes
a session until you get back to your desk.

Includes the daemon, an installable mobile-first PWA, Web Push, git worktree
isolation, transcript persistence, and a terminal escape hatch.

## Why the permission wiring looks like this

Sessions run with `permissionMode: 'default'` and an **empty** `allowedTools`.

That is deliberate and it is the whole design. Claude Code evaluates permissions
in a fixed order — hooks, deny rules, ask rules, permission mode, allow rules,
then `canUseTool`. Anything approved at an earlier step never reaches the
callback. Putting standing rules in `allowedTools` would therefore make those
tools invisible to the approval queue *and* freeze the rule set at `query()`
construction.

An empty allowlist means every tool call falls all the way through to
`canUseTool`, where the `rules` table in SQLite decides. Rules stay editable at
runtime, and the queue sees everything.

`main.ts` treats the SDK's `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning as fatal.
If that ever fires, tool calls are bypassing the gate.

## Approvals never hang forever

From the SDK's own type definitions:

> Fail-closed: an accidental null means no control_response is sent and the tool
> stays blocked indefinitely — **permission prompts have no park deadline.**

Nothing upstream times these out, so agentd does:

- Every pending approval gets `AGENTD_APPROVAL_TTL_SEC` (default 1800) and is
  auto-denied after it, with a message telling Claude to ask again.
- `SIGTERM` denies every parked approval before exit, so no subprocess is left
  blocked on a promise that will never settle.
- Approvals still `pending` at startup are leftovers whose promises died with
  the previous process, so they are retired to `abandoned`.
- `ApprovalGate.request()` is contractually guaranteed to settle.

## Standing rules

An inbox that asks about every `Read` gets ignored within a day, so resolving an
approval can create a rule in the same call:

```bash
curl -XPOST localhost:8787/api/approvals/$ID/resolve \
  -H 'content-type: application/json' -d '{
    "decision": "allow",
    "remember": { "scope": "global", "matchKind": "prefix", "matchValue": "git " }
  }'
```

Rules match on the tool's *primary input field* (`Bash`→`command`,
`Read`/`Edit`/`Write`→`file_path`, `Grep`/`Glob`→`pattern`, …) so `Bash` +
`prefix` + `git ` expresses what a person would actually write. Session-scoped
rules are considered before global ones, and within a scope a `deny` beats an
`allow`.

## The PWA

Served from `/`. Add it to the iOS Home Screen — iOS delivers Web Push only to
an installed PWA, so this is not optional if you want to be told about
approvals.

Views: session dashboard, approval inbox, per-session chat with collapsed tool
calls, mobile diff reviewer, and a real terminal. Dictation uses the Web Speech
API and the button hides itself where the API is absent.

The rule that shapes the client: **the WebSocket is a hint, never the source of
truth.** iOS suspends sockets the moment the app backgrounds — exactly when the
approval you care about arrives — so the socket only ever triggers a refetch,
every view can rebuild from REST alone, and returning to the foreground always
reconnects and refetches rather than assuming continuity.

## Notifications

Push is the only wake path that works on a backgrounded iOS PWA. VAPID keys are
generated on first boot and stored in the database. Push carries only a summary;
the app fetches real state on open. Because iOS permits no silent push, only
genuinely notify-worthy events are sent — pending approvals and failed sessions,
never routine stream traffic. Subscriptions returning 404/410 are deleted rather
than retried, since they are gone for good.

## Worktrees

Passing `repo` when starting a session creates an `agentd/<short-id>` branch and
its own worktree, so parallel sessions on one repository cannot fight over the
index. The worktree is left behind when the session ends — merging is a decision
for you, not a side effect — and `DELETE /api/sessions/:id/worktree` is the
deliberate cleanup.

## Surviving a restart

Transcripts are mirrored to SQLite through the SDK's `SessionStore` interface,
so `POST /api/sessions/:id/resume` can restart a session that a crash killed.
The subprocess itself never survives. `mirror_error` messages are logged and
pushed to the bus rather than swallowed, because silent mirror failure means
silently losing the ability to resume.

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
`CLAUDE_CODE_OAUTH_TOKEN`. A stray API key in a `.env` would silently move every
session onto metered API billing. So the credential audit runs before anything
opens a socket, and exits `78` (`EX_CONFIG`) rather than starting.

It also warns — but does not fail — when the token is missing while stored
`/login` credentials exist on the host, because the subprocess quietly runs on
those instead of the credential you configured.

## HTTP API

Binds `127.0.0.1` by default and has **no authentication of its own**. Tailscale
is the perimeter: front it with `tailscale serve` and never expose it via
Funnel, which is public. `/pty` is a shell as the agentd user, so treat reaching
this daemon as equivalent to SSH access.

| Method | Path | |
|---|---|---|
| GET | `/api/health` | uptime, live sessions, parked approvals |
| GET/POST | `/api/sessions` | list / start (`{prompt, title?, cwd?, repo?, branch?}`) |
| GET | `/api/sessions/:id` | one session |
| POST | `/api/sessions/:id/message` | `{text}` — next turn in an open session |
| POST | `/api/sessions/:id/resume` | `{prompt}` — restart from the mirrored transcript |
| POST | `/api/sessions/:id/end` | close input; finish after this turn |
| POST | `/api/sessions/:id/interrupt` | abort now |
| GET | `/api/sessions/:id/diff` | per-file counts + unified patch |
| DELETE | `/api/sessions/:id/worktree` | remove it (`?force=1`) |
| GET | `/api/approvals?status=&session=` | `pending` (default), `allowed`, `denied`, `expired`, `abandoned` |
| POST | `/api/approvals/:id/resolve` | `{decision, message?, remember?}` |
| GET/POST/DELETE | `/api/rules` | standing rules |
| GET | `/api/events?session=&after=` | append-only event log |
| GET/POST | `/api/push/{key,subscribe,unsubscribe,test}` | Web Push |
| POST | `/api/debug/approvals/simulate` | 404 unless `AGENTD_ALLOW_SIMULATE=1` |
| WS | `/ws` | live events; `{type:"catchup",after}` backfills |
| WS | `/pty?session=` | terminal |

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
| `AGENTD_PUBLIC_DIR` | `../public` | PWA assets |
| `AGENTD_PUSH_CONTACT` | `mailto:agentd@localhost` | VAPID `sub` claim |
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

Verified separately against live sessions, not simulations:

- A real `Bash` call parked on `canUseTool`, surfaced with the SDK's own
  `toolUseID` and `displayName`, was resolved over curl, and the session ran to
  completion returning the command's actual output.
- The same loop driven from the PWA in a mobile viewport: a live session's
  approval was allowed by tapping **Allow**, and the daemon recorded
  `decided_by=user`.
- Chat with collapsed tool calls, the diff reviewer, and a live PTY in the
  session's worktree all render and function.

## Known gaps

- **No auth.** Deliberate — Tailscale is the perimeter and this is single-user.
  Anything multi-user needs a real authn layer before it goes anywhere.
- **No per-session MCP allowlist.** Every session is its own subprocess with its
  own MCP servers. Heavy servers × parallel sessions will exhaust the box; the
  SDK suggests ~1 GiB per agent as a floor, not a ceiling.
- **Resume loses the in-flight turn.** The mirror holds completed entries; a
  subprocess killed mid-tool-call cannot be restored to that instant.
- **Diff is working-tree only** (`git diff HEAD`); untracked files do not appear.
- **`title` is not always populated** by the bridge — live testing saw both a
  populated `title` and a null one with only `displayName` — so every surface
  falls back through `title → description → toolName + primary input`.
