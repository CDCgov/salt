#!/bin/bash
#
# run-mcp-tests.sh — run the server integration harnesses against a throwaway
# copy of the database, then restore it. Starts a dedicated server on a test
# port, runs the harnesses, and cleans everything up.
#
#   scripts/test-mcp.mjs              MCP report tools + OAuth
#   scripts/test-mcp-survey.mjs       MCP survey and lab test tools (plan item 2)
#   scripts/test-mcp-settings.mjs     System page and MCP switches (item 3)
#   scripts/test-other-specify.mjs    "other, specify" options on the server (item 4)
#   scripts/test-survey-copy.mjs      web "copy survey" / "new version" keep everything
#   scripts/test-report-schedule.mjs  scheduled reports run, follow edits, catch up missed runs
#   scripts/test-browser.mjs          pages in real Chrome (only with BROWSER=1 or BROWSER=only)
#
# Usage: bash scripts/run-mcp-tests.sh           # npm run test:integration (or test:mcp)
#        BROWSER=1 bash scripts/run-mcp-tests.sh  # also the browser test
#        BROWSER=only bash scripts/run-mcp-tests.sh  # npm run test:browser
# The browser test uses Playwright (dev dependency) with the installed Chrome;
# set PW_CHANNEL=chromium to use Playwright's own browser instead.
# Needs the sqlite3 command-line tool. Exit code 0 = everything passed.

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
    # Delete the seeded catch-up report's rendered output (its run is only in the test DB).
    for id in $(sqlite3 "$DB" "SELECT run_id FROM report_runs WHERE report_id IN (SELECT id FROM reports WHERE name = 'Scheduler catch-up test')" 2>/dev/null); do
        rm -rf "data/reports/runs/$id"
    done
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

# A schedule whose run fell due while the server was "down": the scheduler
# must run it once at startup (checked by test-report-schedule.mjs).
echo "[test] seeding an overdue report schedule"
sqlite3 "$DB" "INSERT INTO reports (name, qmd_content, created_by, created_at, updated_at)
    VALUES ('Scheduler catch-up test', '---
title: Scheduler catch-up test
format: html
---

Caught up.
', 1, datetime('now'), datetime('now'));
  INSERT INTO report_schedules (report_id, schedule_type, schedule_time, is_active, next_run)
    VALUES (last_insert_rowid(), 'daily', '00:00', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour'));" \
    || { echo "cannot seed report schedule"; exit 2; }

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

RC=0
run() {   # run <label> <script>
    echo "[test] running $1"
    BASE="http://localhost:$PORT" node "$2"
    local rc=$?
    [[ $RC -eq 0 ]] && RC=$rc
}

if [[ "${BROWSER:-}" != "only" ]]; then
    run "MCP report tools / OAuth harness" scripts/test-mcp.mjs
    run "MCP survey / lab test tools harness" scripts/test-mcp-survey.mjs
    run "System page / MCP switches harness" scripts/test-mcp-settings.mjs
    run "other, specify harness" scripts/test-other-specify.mjs
    run "survey copy harness" scripts/test-survey-copy.mjs
    run "report schedule harness" scripts/test-report-schedule.mjs
fi
if [[ -n "${BROWSER:-}" ]]; then
    run "browser test (Chrome)" scripts/test-browser.mjs
fi

echo "[test] server startup failures: $(grep -ciE 'cannot find module|EADDRINUSE|listen|unhandled' "$LOG" || true)"
exit $RC
