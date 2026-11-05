#!/bin/bash
#
# run-mcp-tests.sh — run the MCP integration harness against a throwaway copy of
# the database, then restore it. Starts a dedicated server on a test port with
# MCP enabled, runs scripts/test-mcp.mjs, and cleans everything up.
#
# Usage: bash scripts/run-mcp-tests.sh
# Exit code propagates from the harness (0 = all passed).

set -u
cd "$(dirname "$0")/.."

PORT=3100
DB=data/database/salt.db
BACKUP="/tmp/salt_mcp_test_pretest.db"
LOG=/tmp/salt_mcp_test_server.log
PIDFILE=/tmp/salt_mcp_test.pid

# Use throwaway instructions/templates locations so the test seeds fresh from
# the shipped defaults and never touches the operator's editable data/reports.
export MCP_INSTRUCTIONS_FILE=/tmp/salt_mcp_test_instructions.md
export MCP_TEMPLATES_DIR=/tmp/salt_mcp_test_templates
export MCP_SURVEY_GUIDE_FILE=/tmp/salt_mcp_test_survey_guide.md
rm -f "$MCP_INSTRUCTIONS_FILE" "$MCP_SURVEY_GUIDE_FILE"; rm -rf "$MCP_TEMPLATES_DIR"

cleanup() {
    [[ -f "$PIDFILE" ]] && kill "$(cat "$PIDFILE")" 2>/dev/null
    sleep 1
    # Restore the original DB (discards all test writes) and clear temp renders.
    if [[ -f "$BACKUP" ]]; then cp -f "$BACKUP" "$DB" && rm -f "$BACKUP"; fi
    rm -rf data/reports/temp/* 2>/dev/null
    rm -f "$PIDFILE" "$MCP_INSTRUCTIONS_FILE" "$MCP_SURVEY_GUIDE_FILE"; rm -rf "$MCP_TEMPLATES_DIR"
}
trap cleanup EXIT

echo "[test] backing up $DB"
cp -f "$DB" "$BACKUP" || { echo "cannot back up DB"; exit 2; }

# Report building is off by default; the harnesses need both tool groups on.
echo "[test] turning on both MCP switches in the test database"
node -e "const s=require('./src/services/systemSettings');(async()=>{await s.set('mcp_reports_enabled',true);await s.set('mcp_survey_editing_enabled',true);process.exit(0)})().catch(e=>{console.error(e);process.exit(1)})" \
    || { echo "cannot set MCP switches"; exit 2; }

echo "[test] starting server on :$PORT"
PORT=$PORT MCP_PUBLIC_URL=http://localhost:$PORT NODE_ENV=development \
    node src/app.js > "$LOG" 2>&1 &
echo $! > "$PIDFILE"

echo "[test] waiting for /health"
for i in $(seq 1 30); do
    if curl -fsS -o /dev/null "http://localhost:$PORT/health" 2>/dev/null; then break; fi
    sleep 1
    if [[ $i -eq 30 ]]; then echo "[test] server did not start; log:"; cat "$LOG"; exit 2; fi
done

echo "[test] running harness"
BASE="http://localhost:$PORT" node scripts/test-mcp.mjs
RC=$?

echo "[test] running survey / lab test tools harness"
BASE="http://localhost:$PORT" node scripts/test-mcp-survey.mjs
RC2=$?
[[ $RC -eq 0 ]] && RC=$RC2

echo "[test] running System page / MCP switches harness"
BASE="http://localhost:$PORT" node scripts/test-mcp-settings.mjs
RC3=$?
[[ $RC -eq 0 ]] && RC=$RC3

echo "[test] server startup failures: $(grep -ciE 'cannot find module|EADDRINUSE|listen|unhandled' "$LOG" || true)"
exit $RC
