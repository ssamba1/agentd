#!/usr/bin/env bash
# Covers the surface added after the approval-loop skeleton: worktrees, diffs
# (including untracked files), MCP scoping, Web Push registration, the event
# socket, multi-turn input, and resume-after-restart.
#
# The resume and multi-turn checks drive a real Claude session, so this script
# needs working credentials. smoke.sh does not, and stays the hermetic suite.
set -uo pipefail

PORT="${PORT:-8798}"
BASE="http://127.0.0.1:${PORT}"
TMP="$(mktemp -d)"
DB="${TMP}/x.db"
PASS=0; FAIL=0
LIVE="${AGENTD_TEST_LIVE:-1}"

ok()   { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1"; echo "        $2"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi }
jq_() { node -pe "JSON.parse(require('fs').readFileSync(0,'utf8'))$1"; }

cleanup() {
  if [ -n "${SRV:-}" ]; then kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; fi
  for _ in 1 2 3 4 5; do rm -rf "$TMP" 2>/dev/null && break; sleep 0.3; done
}
trap cleanup EXIT

boot() { # boot [extra env assignments...]
  env AGENTD_PORT="$PORT" AGENTD_DB="$DB" AGENTD_WORK_ROOT="${TMP}/work" \
      AGENTD_ALLOW_SIMULATE=1 AGENTD_APPROVAL_TTL_SEC=120 "$@" \
      node dist/main.js >>"${TMP}/server.log" 2>&1 &
  SRV=$!
  for _ in $(seq 1 60); do curl -sf "${BASE}/api/health" >/dev/null 2>&1 && return 0; sleep 0.2; done
  echo "server failed to start:"; tail -20 "${TMP}/server.log"; exit 1
}
stop() { kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; SRV=""; }

# A throwaway git repo to run worktree and diff checks against.
REPO="${TMP}/repo"
mkdir -p "$REPO"
# On Windows the daemon resolves to native paths, so hand it a native path and
# translate back for shell-side file operations.
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
unixify() { if command -v cygpath >/dev/null 2>&1; then cygpath -u "$1"; else printf '%s' "$1"; fi; }
REPO_NATIVE="$(native "$REPO")"
git -C "$REPO" init -q
git -C "$REPO" config user.email t@example.com
git -C "$REPO" config user.name test
echo "line one" > "$REPO/tracked.txt"
git -C "$REPO" add -A
git -C "$REPO" commit -qm init

echo "== 1. MCP scoping =="
cat > "${TMP}/mcp.json" <<'JSON'
{ "mcpServers": {
    "alpha": { "type": "stdio", "command": "node", "args": ["-e", ""] },
    "beta":  { "type": "stdio", "command": "node", "args": ["-e", ""] } } }
JSON
boot AGENTD_MCP_CONFIG="${TMP}/mcp.json"
check "reports configured servers" "$(curl -sf "${BASE}/api/mcp" | jq_ '.servers.sort().join(",")')" "alpha,beta"
check "strict mode is on" "$(curl -sf "${BASE}/api/mcp" | jq_ '.strict')" "true"
check "unknown MCP server is rejected" \
  "$(curl -s -o /dev/null -w '%{http_code}' -XPOST "${BASE}/api/sessions" \
     -H 'content-type: application/json' -d '{"prompt":"x","mcpServers":["nope"]}')" "400"
check "non-array mcpServers is rejected" \
  "$(curl -s -o /dev/null -w '%{http_code}' -XPOST "${BASE}/api/sessions" \
     -H 'content-type: application/json' -d '{"prompt":"x","mcpServers":"alpha"}')" "400"
stop

out=$(env AGENTD_PORT="$PORT" AGENTD_DB="$DB" AGENTD_ALLOW_SIMULATE=1 \
      AGENTD_MCP_CONFIG="${TMP}/does-not-exist.json" node dist/main.js 2>&1); rc=$?
check "unreadable MCP config exits EX_CONFIG" "$rc" "78"

echo "== 2. worktree isolation =="
boot
sid=$(curl -sf -XPOST "${BASE}/api/sessions" -H 'content-type: application/json' \
      -d "$(node -pe "JSON.stringify({prompt:'noop',repo:process.argv[1],title:'wt'})" "$REPO_NATIVE")" | jq_ '.id')
[ -n "$sid" ] && ok "started session on a repo" || bad "started session on a repo" "no id"
row=$(curl -sf "${BASE}/api/sessions/${sid}")
check "marked as a worktree" "$(echo "$row" | jq_ '.worktree')" "1"
br=$(echo "$row" | jq_ '.branch')
case "$br" in agentd/*) ok "created an agentd/ branch (${br})";; *) bad "created an agentd/ branch" "$br";; esac
wt_native=$(echo "$row" | jq_ '.cwd')
wt=$(unixify "$wt_native")
[ -d "$wt" ] && ok "worktree directory exists" || bad "worktree directory exists" "$wt missing"
git -C "$REPO" worktree list | grep -q "$br" && ok "git knows about the worktree" \
  || bad "git knows about the worktree" "$(git -C "$REPO" worktree list)"

echo "== 3. diff includes untracked files =="
# The regression this guards: `git diff HEAD` cannot see new files, so a
# session whose whole contribution is added files used to show an empty diff.
echo "line two" >> "$wt/tracked.txt"
printf 'brand new\nsecond line\n' > "$wt/added.txt"
d=$(curl -sf "${BASE}/api/sessions/${sid}/diff")
check "modified file is listed" "$(echo "$d" | jq_ '.files.filter(f=>f.path==="tracked.txt").length')" "1"
check "untracked file is listed" "$(echo "$d" | jq_ '.files.filter(f=>f.path==="added.txt").length')" "1"
check "untracked file is marked added" "$(echo "$d" | jq_ '.files.find(f=>f.path==="added.txt").status')" "A"
check "untracked line count is counted" "$(echo "$d" | jq_ '.files.find(f=>f.path==="added.txt").added')" "2"
echo "$d" | jq_ '.patch' | grep -q 'diff --git a/added.txt b/added.txt' \
  && ok "untracked patch header is normalised" \
  || bad "untracked patch header is normalised" "no rewritten header in patch"

echo "== 4. Web Push registration =="
key=$(curl -sf "${BASE}/api/push/key" | jq_ '.publicKey')
[ ${#key} -gt 60 ] && ok "VAPID key generated (${#key} chars)" || bad "VAPID key generated" "got '${key}'"
check "push reports enabled" "$(curl -sf "${BASE}/api/push/key" | jq_ '.enabled')" "true"
curl -sf -XPOST "${BASE}/api/push/subscribe" -H 'content-type: application/json' \
  -d '{"endpoint":"https://example.invalid/ep1","keys":{"p256dh":"BKxQ","auth":"aGk"},"label":"iPad"}' >/dev/null
check "subscription stored" "$(curl -sf "${BASE}/api/push/subscriptions" | jq_ '.length')" "1"
curl -sf -XPOST "${BASE}/api/push/subscribe" -H 'content-type: application/json' \
  -d '{"endpoint":"https://example.invalid/ep1","keys":{"p256dh":"BKxQ2","auth":"aGk2"}}' >/dev/null
check "re-subscribing updates in place" "$(curl -sf "${BASE}/api/push/subscriptions" | jq_ '.length')" "1"
check "unsubscribe removes it" \
  "$(curl -sf -XPOST "${BASE}/api/push/unsubscribe" -H 'content-type: application/json' \
     -d '{"endpoint":"https://example.invalid/ep1"}' | jq_ '.removed')" "true"

# VAPID keys must survive a restart or every device silently unsubscribes.
stop; boot
check "VAPID key persists across restart" "$(curl -sf "${BASE}/api/push/key" | jq_ '.publicKey')" "$key"

echo "== 5. event socket =="
res=$(node -e '
const WebSocket=require("ws");
const ws=new WebSocket("ws://127.0.0.1:'"$PORT"'/ws");
let hello=false, got=false;
const done=(v)=>{console.log(v);process.exit(0)};
setTimeout(()=>done(`timeout hello=${hello} event=${got}`),8000);
ws.on("message",(d)=>{const m=JSON.parse(d);
  if(m.kind==="hello"){hello=true;
    fetch("'"$BASE"'/api/debug/approvals/simulate",{method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({sessionId:"'"$sid"'",toolName:"Bash",input:{command:"echo hi"}})});}
  else if(m.kind==="approval.pending"){got=true;
    done(hello&&m.data&&m.data.summary?"ok":"missing-summary");}});
ws.on("error",e=>done("error: "+e.message));')
check "socket sends hello then pushes approval.pending" "$res" "ok"

echo "== 6. approval TTL survives the new wiring =="
n=$(curl -sf "${BASE}/api/approvals?status=pending" | jq_ '.length')
[ "$n" -ge 1 ] && ok "socket-triggered approval parked" || bad "socket-triggered approval parked" "n=$n"

if [ "$LIVE" != "1" ]; then
  echo "== skipping live-session checks (AGENTD_TEST_LIVE=0) =="
else
  echo "== 7. multi-turn and resume (live session) =="
  # Auto-approve everything so the session runs unattended; this also exercises
  # the wildcard rule path.
  curl -sf -XPOST "${BASE}/api/rules" -H 'content-type: application/json' \
    -d '{"toolName":"*","matchKind":"any","action":"allow","note":"test harness"}' >/dev/null

  lid=$(curl -sf -XPOST "${BASE}/api/sessions" -H 'content-type: application/json' \
        -d '{"prompt":"Reply with exactly the word READY and use no tools.","title":"live"}' | jq_ '.id')
  for _ in $(seq 1 45); do
    st=$(curl -sf "${BASE}/api/sessions/${lid}" | jq_ '.status')
    [ "$st" = "idle" ] && break
    [ "$st" = "failed" ] && break
    sleep 2
  done
  check "session reaches idle, not completed, after one turn" "$st" "idle"

  check "second turn is accepted on the open session" \
    "$(curl -s -o /dev/null -w '%{http_code}' -XPOST "${BASE}/api/sessions/${lid}/message" \
       -H 'content-type: application/json' -d '{"text":"Reply with exactly the word SECOND."}')" "200"
  for _ in $(seq 1 45); do
    st=$(curl -sf "${BASE}/api/sessions/${lid}" | jq_ '.status')
    [ "$st" = "idle" ] || [ "$st" = "failed" ] && break
    sleep 2
  done
  turns=$(curl -sf "${BASE}/api/events?session=${lid}" | jq_ '.filter(e=>e.kind==="sdk.result").length')
  [ "$turns" -ge 2 ] && ok "two turns recorded in one session" || bad "two turns recorded" "turns=$turns"

  sdk=$(curl -sf "${BASE}/api/sessions/${lid}" | jq_ '.sdk_session_id')
  [ -n "$sdk" ] && [ "$sdk" != "null" ] && ok "sdk session id captured" || bad "sdk session id captured" "$sdk"
  DB_NATIVE="$(native "$DB")"
  entries=$(node -e "
    const D=require('better-sqlite3')(process.argv[1]);
    console.log(D.prepare('SELECT COUNT(*) c FROM session_entries WHERE session_id=?').get(process.argv[2]).c);
  " "$DB_NATIVE" "$sdk")
  [ "$entries" -gt 0 ] && ok "transcript mirrored to SessionStore (${entries} entries)" \
    || bad "transcript mirrored to SessionStore" "0 entries"

  echo "-- restarting daemon --"
  stop; boot
  check "shutdown recorded as interrupted, not failed" \
    "$(curl -sf "${BASE}/api/sessions/${lid}" | jq_ '.status')" "interrupted"

  code=$(curl -s -o /dev/null -w '%{http_code}' -XPOST "${BASE}/api/sessions/${lid}/resume" \
         -H 'content-type: application/json' -d '{"prompt":"Reply with exactly the word RESUMED."}')
  check "resume accepted after restart" "$code" "200"
  for _ in $(seq 1 45); do
    st=$(curl -sf "${BASE}/api/sessions/${lid}" | jq_ '.status')
    [ "$st" = "idle" ] || [ "$st" = "failed" ] && break
    sleep 2
  done
  check "resumed session runs to idle" "$st" "idle"
  err=$(curl -sf "${BASE}/api/sessions/${lid}" | jq_ '.error ?? ""')
  [ -z "$err" ] || [ "$err" = "agentd restarted while this session was running" ] \
    && ok "no new error after resume" || bad "no new error after resume" "$err"
fi

echo
echo "passed ${PASS}, failed ${FAIL}"
[ "$FAIL" -eq 0 ]
