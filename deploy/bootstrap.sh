#!/usr/bin/env bash
# Provision agentd on a fresh Linux box. Idempotent: safe to re-run to upgrade.
#
#   scp deploy/bootstrap.sh root@box:/tmp/
#   ssh root@box 'CLAUDE_CODE_OAUTH_TOKEN=<token> bash /tmp/bootstrap.sh'
#
# The token must come from `claude setup-token` on a machine with a browser.
# It is written to /etc/agentd/claude.env (0640, root-owned) and nowhere else.
set -euo pipefail

REPO="${AGENTD_REPO:-https://github.com/ssamba1/agentd.git}"
REF="${AGENTD_REF:-main}"
PREFIX="${AGENTD_PREFIX:-/opt/agentd}"
PORT="${AGENTD_PORT:-8787}"

die() { echo "ERROR: $*" >&2; exit 1; }
say() { echo "==> $*"; }

[ "$(id -u)" -eq 0 ] || die "run as root"
[ "$(uname -s)" = "Linux" ] || die "this script targets Linux; the systemd unit will not work elsewhere"

# --- token ------------------------------------------------------------------
# Checked first: everything after this is pointless without it, and finding out
# at the end wastes an install.
if [ -f /etc/agentd/claude.env ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  say "reusing existing /etc/agentd/claude.env"
elif [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  case "$CLAUDE_CODE_OAUTH_TOKEN" in
    sk-ant-*|*oat*) : ;;
    *) echo "WARNING: token does not look like a setup-token; continuing anyway" >&2 ;;
  esac
else
  die "CLAUDE_CODE_OAUTH_TOKEN is not set and /etc/agentd/claude.env does not exist.
     Run 'claude setup-token' on a machine with a browser, then re-run this with
     CLAUDE_CODE_OAUTH_TOKEN=<token> bash bootstrap.sh"
fi

# agentd refuses to start if any of these are in its environment, because they
# outrank the subscription token and would move every session onto metered API
# billing. Catch a system-wide one here rather than in a restart loop.
for v in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_USE_BEDROCK \
         CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY; do
  if grep -rqs "^${v}=" /etc/environment /etc/profile.d/ 2>/dev/null; then
    die "$v is set system-wide. It outranks CLAUDE_CODE_OAUTH_TOKEN and would bill
     the API for every session. Remove it before deploying."
  fi
done

# --- packages ---------------------------------------------------------------
say "installing packages"
export DEBIAN_FRONTEND=noninteractive
if command -v apt-get >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates git python3 build-essential >/dev/null
else
  die "no apt-get; install curl, git, python3 and a C toolchain yourself, then re-run"
fi

# better-sqlite3 and node-pty are native modules; both need headers on some
# distros and a real toolchain if no prebuilt binary matches.
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  say "installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
say "node $(node -v), npm $(npm -v), git $(git --version | awk '{print $3}')"

# --- user and directories ---------------------------------------------------
if ! id agentd >/dev/null 2>&1; then
  say "creating agentd user"
  useradd -r -m -d "$PREFIX" -s /usr/sbin/nologin agentd
fi
install -d -o agentd -g agentd -m 0755 "$PREFIX"
install -d -o agentd -g agentd -m 0700 /var/lib/agentd
install -d -o root   -g agentd -m 0750 /etc/agentd

# --- credentials ------------------------------------------------------------
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  say "writing /etc/agentd/claude.env"
  umask 027
  printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$CLAUDE_CODE_OAUTH_TOKEN" > /etc/agentd/claude.env
  chown root:agentd /etc/agentd/claude.env
  chmod 0640 /etc/agentd/claude.env
fi

# --- code -------------------------------------------------------------------
if [ -d "$PREFIX/.git" ]; then
  say "updating existing checkout"
  sudo -u agentd git -C "$PREFIX" fetch --depth 1 origin "$REF"
  sudo -u agentd git -C "$PREFIX" reset --hard "origin/$REF"
else
  say "cloning $REPO@$REF"
  # The directory already exists as the user's home, so clone into it rather
  # than over it.
  sudo -u agentd git clone --depth 1 --branch "$REF" "$REPO" "$PREFIX/src.tmp"
  shopt -s dotglob
  mv "$PREFIX"/src.tmp/* "$PREFIX"/
  shopt -u dotglob
  rmdir "$PREFIX/src.tmp"
fi

say "installing dependencies"
# NOT --omit=optional: the SDK ships its Claude Code binary through npm optional
# dependencies, and omitting them produces an install that cannot start a session.
sudo -u agentd bash -lc "cd '$PREFIX' && npm ci --no-audit --no-fund"
say "building"
sudo -u agentd bash -lc "cd '$PREFIX' && npm run build"

# --- service ----------------------------------------------------------------
say "installing systemd unit"
sed "s#^ExecStart=.*#ExecStart=$(command -v node) $PREFIX/dist/main.js#; \
     s#^WorkingDirectory=.*#WorkingDirectory=$PREFIX#; \
     s#^Environment=AGENTD_PORT=.*#Environment=AGENTD_PORT=$PORT#" \
    "$PREFIX/deploy/agentd.service" > /etc/systemd/system/agentd.service
systemctl daemon-reload
systemctl enable agentd >/dev/null
systemctl restart agentd

# --- verify -----------------------------------------------------------------
say "waiting for health"
ok=0
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 0.5
done
if [ "$ok" -ne 1 ]; then
  echo "--- agentd did not come up; last 40 log lines ---" >&2
  journalctl -u agentd -n 40 --no-pager >&2 || true
  # Exit 78 from the unit means the credential audit refused to start.
  die "agentd failed to start"
fi
curl -fsS "http://127.0.0.1:${PORT}/api/health"
echo

# --- perimeter --------------------------------------------------------------
echo
if command -v tailscale >/dev/null; then
  if tailscale status >/dev/null 2>&1; then
    say "tailscale is up; publishing to the tailnet"
    tailscale serve --bg "$PORT" || echo "  (could not run 'tailscale serve' automatically)"
    if tailscale serve status 2>/dev/null | grep -qi funnel; then
      echo
      echo "!!! FUNNEL IS ENABLED. That publishes agentd to the public internet."
      echo "!!! /pty is a shell as the agentd user. Turn it off: tailscale funnel --https=443 off"
    fi
    tailscale serve status 2>/dev/null || true
  else
    echo "Tailscale is installed but not connected. Run: tailscale up"
  fi
else
  cat <<'MSG'
Tailscale is NOT installed. agentd is listening on 127.0.0.1 only, so nothing
can reach it yet -- which is the safe state, not a broken one.

agentd has no authentication of its own and /pty is a shell as the agentd user.
Do not expose the port directly. Install Tailscale and publish it to your
tailnet only:

  curl -fsSL https://tailscale.com/install.sh | sh
  tailscale up
  tailscale serve --bg 8787

Never use `tailscale funnel` for this: funnel is public and unauthenticated.
MSG
fi

echo
say "done. journalctl -u agentd -f"
