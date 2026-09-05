# Deploying agentd

Target: one always-on Linux box you own, reached over Tailscale, single user.

## 1. The box

```bash
sudo useradd -r -m -d /opt/agentd -s /usr/sbin/nologin agentd
sudo mkdir -p /opt/agentd /etc/agentd
sudo chown agentd:agentd /opt/agentd
```

Install Node 18+ and git. `git` must be on the agentd user's PATH or worktree
creation fails at session start.

## 2. Code

```bash
sudo -u agentd git clone <your-remote> /opt/agentd
cd /opt/agentd && sudo -u agentd npm ci && sudo -u agentd npm run build
```

`npm ci --omit=optional` breaks the SDK: the bundled Claude Code binary ships
through npm optional dependencies. Install without omitting them.

## 3. Credentials

On a machine with a browser:

```bash
claude setup-token
```

Then on the box, and nowhere else:

```bash
sudo install -o root -g agentd -m 0640 /dev/null /etc/agentd/claude.env
printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$TOKEN" | sudo tee /etc/agentd/claude.env >/dev/null
```

The token is a bearer credential for your entire Claude subscription and it
lasts one year. Put its expiry in a calendar now — renewal needs a browser, and
the failure mode is discovering it from a phone with no way to fix it.

Do not put `ANTHROPIC_API_KEY` in this file. agentd checks for it and refuses to
start (exit 78), because it outranks the subscription token and would silently
move every session onto metered API billing.

## 4. Service

```bash
sudo cp deploy/agentd.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now agentd
journalctl -u agentd -f
```

## 5. The perimeter

agentd binds `127.0.0.1` and has **no authentication of its own**. Tailscale is
the only thing between the internet and a daemon that can run shell commands as
its user. Get this right or nothing else matters.

```bash
tailscale serve --bg 8787
tailscale serve status          # confirm: tailnet-only
```

`serve` publishes to your tailnet and gives you an HTTPS certificate on a
`*.ts.net` name — which Web Push requires, since iOS will not deliver push to an
untrusted certificate.

**Never use `tailscale funnel`.** Funnel publishes to the public internet with
no authentication in front of it. Anyone with the URL would reach `/pty`, which
is a shell as the agentd user. If you genuinely need public reach, put
Cloudflare Tunnel with Cloudflare Access in front instead, and treat that as a
different security review.

Verify you did not accidentally expose it:

```bash
tailscale serve status | grep -i funnel && echo "STOP: funnel is on"
```

## 6. Install the PWA

Open `https://<box>.ts.net/` on the iPad or iPhone, then Share → Add to Home
Screen. This is not cosmetic: iOS delivers Web Push only to an installed PWA.
Open it from the Home Screen, go to Settings, tap **Enable notifications**, then
**Send test notification** to prove the path works before you rely on it.

## 7. Scoping MCP servers (recommended)

Every session is its own subprocess with its own MCP servers, so an inherited
user-level config multiplies across parallel sessions and is the fastest way to
exhaust a small box.

```bash
sudo -u agentd tee /etc/agentd/mcp.json >/dev/null <<'JSON'
{ "mcpServers": {
    "context7": { "type": "http", "url": "https://mcp.context7.com/mcp" }
} }
JSON
```

Add `Environment=AGENTD_MCP_CONFIG=/etc/agentd/mcp.json` to the unit. That
switches sessions to `strictMcpConfig`, which ignores project `.mcp.json`, user
settings and plugins — while `CLAUDE.md`, skills and commands still load, which
is the half worth inheriting. Sessions can then request a subset by name:
`{"prompt": "...", "mcpServers": ["context7"]}`.

Note that a subscription OAuth token cannot reach claude.ai connectors at all.
Anything you had configured there must be re-added here as a direct MCP server
or dropped.

## 8. Check it

```bash
curl -s localhost:8787/api/health | jq
```

`pushEnabled: true`, `mcp` reported at startup in the journal, and
`parkedApprovals: 0` on a fresh boot.
