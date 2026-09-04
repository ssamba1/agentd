#!/usr/bin/env bash
# End-to-end verification of the approval gate.
#
# Exercises the real canUseTool code path (via the simulate endpoint, which
# calls ApprovalGate.request exactly as the SDK callback does) without needing
# a Claude credential or spending tokens.
set -uo pipefail

PORT="${PORT:-8799}"
BASE="http://127.0.0.1:${PORT}"
TMP="$(mktemp -d)"
DB="${TMP}/test.db"
PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1"; echo "        $2"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi }

cleanup() {
  if [ -n "${SRV:-}" ]; then kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; fi
  # Windows holds the SQLite file until the handle is actually released.
  for _ in 1 2 3 4 5; do rm -rf "$TMP" 2>/dev/null && break; sleep 0.3; done
}
trap cleanup EXIT

boot() { # boot <ttl> ; sets SRV
  AGENTD_PORT="$PORT" AGENTD_DB="$DB" AGENTD_WORK_ROOT="${TMP}/work" \
  AGENTD_ALLOW_SIMULATE=1 AGENTD_APPROVAL_TTL_SEC="$1" \
  node dist/main.js >"${TMP}/server.log" 2>&1 &
  SRV=$!
  for _ in $(seq 1 50); do
    curl -sf "${BASE}/health" >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  echo "server failed to start:"; cat "${TMP}/server.log"; exit 1
}

echo "== 1. boot assertions =="

out=$(AGENTD_DB="$DB" ANTHROPIC_API_KEY=sk-ant-fake AGENTD_ALLOW_SIMULATE=1 \
      node dist/main.js 2>&1); rc=$?
check "refuses to start with ANTHROPIC_API_KEY set" "$rc" "78"
case "$out" in *"ANTHROPIC_API_KEY"*) ok "names the offending variable";;
  *) bad "names the offending variable" "$out";; esac

out=$(AGENTD_DB="$DB" CLAUDE_CODE_USE_BEDROCK=1 AGENTD_ALLOW_SIMULATE=1 \
      node dist/main.js 2>&1); rc=$?
check "refuses to start with CLAUDE_CODE_USE_BEDROCK set" "$rc" "78"

out=$(AGENTD_DB="$DB" node dist/main.js 2>&1); rc=$?
check "refuses to start with no token and no simulate flag" "$rc" "78"

echo "== 2. approval parks, then resolves =="
boot 60

sid=$(curl -sf -XPOST "${BASE}/sessions" -H 'content-type: application/json' \
      -d '{"prompt":"smoke test","title":"smoke"}' | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).id')
[ -n "$sid" ] && ok "created session" || bad "created session" "no id returned"

curl -sf -XPOST "${BASE}/debug/approvals/simulate" -H 'content-type: application/json' \
  -d "{\"sessionId\":\"${sid}\",\"toolName\":\"Bash\",\"input\":{\"command\":\"git status\"}}" >/dev/null
sleep 0.3

pending=$(curl -sf "${BASE}/approvals?status=pending")
n=$(echo "$pending" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).length')
check "approval is parked as pending" "$n" "1"

parked=$(curl -sf "${BASE}/health" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).parkedApprovals')
check "gate reports one parked waiter" "$parked" "1"

aid=$(echo "$pending" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8"))[0].id')
res=$(curl -sf -XPOST "${BASE}/approvals/${aid}/resolve" -H 'content-type: application/json' \
      -d '{"decision":"allow","remember":{"scope":"global","matchKind":"prefix","matchValue":"git "}}')
rid=$(echo "$res" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).ruleId ?? ""')
[ -n "$rid" ] && ok "resolve created a standing rule" || bad "resolve created a standing rule" "$res"

st=$(curl -sf "${BASE}/approvals/${aid}" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).status')
check "approval is now allowed" "$st" "allowed"

parked=$(curl -sf "${BASE}/health" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).parkedApprovals')
check "waiter was released" "$parked" "0"

check "resolving twice is rejected" \
  "$(curl -s -o /dev/null -w '%{http_code}' -XPOST "${BASE}/approvals/${aid}/resolve" \
     -H 'content-type: application/json' -d '{"decision":"allow"}')" "409"

echo "== 3. standing rule auto-approves without parking =="
curl -sf -XPOST "${BASE}/debug/approvals/simulate" -H 'content-type: application/json' \
  -d "{\"sessionId\":\"${sid}\",\"toolName\":\"Bash\",\"input\":{\"command\":\"git diff\"}}" >/dev/null
sleep 0.3

n=$(curl -sf "${BASE}/approvals?status=pending" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).length')
check "matching call did not park" "$n" "0"

by=$(curl -sf "${BASE}/approvals?status=allowed" \
     | node -pe 'const a=JSON.parse(require("fs").readFileSync(0,"utf8")); a.find(x=>JSON.parse(x.input_json).command==="git diff").decided_by')
check "decided by rule, not user" "$by" "rule"

hits=$(curl -sf "${BASE}/rules" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).find(r=>r.id==='${rid}').hits")
check "rule hit counter incremented" "$hits" "1"

echo "== 4. non-matching call still parks =="
curl -sf -XPOST "${BASE}/debug/approvals/simulate" -H 'content-type: application/json' \
  -d "{\"sessionId\":\"${sid}\",\"toolName\":\"Bash\",\"input\":{\"command\":\"rm -rf /\"}}" >/dev/null
sleep 0.3
n=$(curl -sf "${BASE}/approvals?status=pending" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).length')
check "non-matching command parks" "$n" "1"

echo "== 5. restart retires orphaned approvals =="
kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null
boot 60
n=$(curl -sf "${BASE}/approvals?status=pending" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).length')
check "no approvals left pending after restart" "$n" "0"
n=$(curl -sf "${BASE}/approvals?status=abandoned" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).length')
check "orphan was marked abandoned" "$n" "1"
st=$(curl -sf "${BASE}/sessions/${sid}" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).status')
case "$st" in interrupted|failed|completed) ok "session no longer claims to be running (${st})";;
  *) bad "session no longer claims to be running" "status=${st}";; esac

echo "== 6. TTL auto-denies =="
kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null
boot 2
curl -sf -XPOST "${BASE}/debug/approvals/simulate" -H 'content-type: application/json' \
  -d "{\"sessionId\":\"${sid}\",\"toolName\":\"Write\",\"input\":{\"file_path\":\"/etc/passwd\"}}" >/dev/null
sleep 0.3
n=$(curl -sf "${BASE}/approvals?status=pending" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).length')
check "parked before TTL" "$n" "1"
sleep 2.5
n=$(curl -sf "${BASE}/approvals?status=expired" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).length')
check "auto-denied after TTL" "$n" "1"
parked=$(curl -sf "${BASE}/health" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).parkedApprovals')
check "waiter released on expiry" "$parked" "0"

echo "== 7. simulate endpoint is off by default =="
kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null
AGENTD_PORT="$PORT" AGENTD_DB="$DB" AGENTD_WORK_ROOT="${TMP}/work" \
  CLAUDE_CODE_OAUTH_TOKEN=fake-token-for-routing-test \
  node dist/main.js >"${TMP}/server2.log" 2>&1 &
SRV=$!
for _ in $(seq 1 50); do curl -sf "${BASE}/health" >/dev/null 2>&1 && break; sleep 0.2; done
check "simulate returns 404 without the flag" \
  "$(curl -s -o /dev/null -w '%{http_code}' -XPOST "${BASE}/debug/approvals/simulate" \
     -H 'content-type: application/json' -d '{"sessionId":"x","toolName":"Bash"}')" "404"

echo
echo "passed ${PASS}, failed ${FAIL}"
[ "$FAIL" -eq 0 ]
