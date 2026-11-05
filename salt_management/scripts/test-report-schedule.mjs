/**
 * test-report-schedule.mjs — scheduled reports: input checks, next run times
 * (UTC, from the real cron job), a schedule actually firing, edits taking
 * effect without a restart (inactive, deleted schedule, deleted report), and
 * the startup catch-up of a run missed while the server was down (seeded by
 * scripts/run-mcp-tests.sh as report "Scheduler catch-up test").
 *
 * Waits for the next whole minute, so it takes up to two minutes. Needs Quarto.
 *
 * Writes to the database it runs against, so run it via
 * scripts/run-mcp-tests.sh (throwaway copy) or against a scratch copy.
 * Env: BASE (default http://localhost:3100), SALT_DB_PATH (default
 * data/database/salt.db). Needs the sqlite3 command-line tool.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const bcrypt = require('bcrypt');
const BASE = process.env.BASE || 'http://localhost:3100';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.SALT_DB_PATH || path.join(ROOT, 'data', 'database', 'salt.db');
const q = (s) => { const t = execFileSync('sqlite3', ['-json', DB, s]).toString().trim(); return t ? JSON.parse(t) : []; };
let cookie = '', pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) pass++; else { fail++; console.log('FAIL', n, JSON.stringify(d ?? '').slice(0, 600)); } };
const api = async (m, p, b) => { const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b && JSON.stringify(b) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; return { status: r.status, json: await r.json().catch(() => null) }; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const scheduledRuns = (id) => q(`SELECT run_id, status FROM report_runs WHERE report_id=${id} AND run_type='scheduled'`);

// A throwaway administrator for this run.
const ADMIN = 'zz_test_admin_' + process.pid;
const ADMIN_PW = 'Zz-' + Date.now();
execFileSync('sqlite3', [DB, `INSERT OR REPLACE INTO admin_users (username, password_hash, role, is_active)
    VALUES ('${ADMIN}', '${await bcrypt.hash(ADMIN_PW, 10)}', 'administrator', 1)`]);
const dropAdmin = () => execFileSync('sqlite3', [DB, `DELETE FROM admin_users WHERE username = '${ADMIN}'`]);
await api('POST', '/api/auth/login', { username: ADMIN, password: ADMIN_PW });

const qmd = (title) => `---\ntitle: ${title}\nformat: html\n---\n\nScheduled test.\n`;
const newReport = async (name) => (await api('POST', '/api/admin/reports', { name, qmd_content: qmd(name) })).json.reportId;
const createdRuns = [];

// 1. Startup catch-up: the seeded overdue schedule ran once at startup.
const missed = q(`SELECT r.id, rs.last_run, rs.next_run FROM reports r JOIN report_schedules rs ON rs.report_id=r.id WHERE r.name='Scheduler catch-up test'`)[0];
if (!missed) {
  ok('seeded "Scheduler catch-up test" schedule exists (run via scripts/run-mcp-tests.sh)', false);
} else {
  let runs = [];
  for (let i = 0; i < 60 && !(runs.length && runs[0].status !== 'running'); i++) { runs = scheduledRuns(missed.id); if (!runs.length || runs[0].status === 'running') await sleep(1000); }
  ok('missed run caught up once at startup', runs.length === 1 && runs[0].status === 'completed', runs);
  const after = q(`SELECT last_run, next_run FROM report_schedules WHERE report_id=${missed.id}`)[0];
  ok('catch-up records last_run and moves next_run to the future', after.last_run && new Date(after.next_run) > new Date(), after);
  createdRuns.push(...runs.map(r => r.run_id));
}

// 2. Input checks
const A = await newReport('ZZ sched A ' + Date.now());
for (const [body, why] of [
  [{ schedule_type: 'daily', schedule_time: '25:00', is_active: true }, 'hour 25'],
  [{ schedule_type: 'daily', schedule_time: '9am', is_active: true }, 'not HH:MM'],
  [{ schedule_type: 'weekly', schedule_time: '09:00', schedule_day: 7, is_active: true }, 'weekday 7'],
  [{ schedule_type: 'monthly', schedule_time: '09:00', schedule_day: 0, is_active: true }, 'month day 0'],
  [{ schedule_type: 'hourly', schedule_time: '09:00', is_active: true }, 'unknown type'],
]) {
  const r = await api('POST', `/api/admin/reports/${A}/schedule`, body);
  ok(`schedule rejected: ${why}`, r.status === 400, r);
}
ok('schedule for a missing report is refused', (await api('POST', '/api/admin/reports/999999/schedule', { schedule_type: 'daily', schedule_time: '09:00', is_active: true })).status === 404);

// 3. Next run times come from the cron job, in UTC
let r = await api('POST', `/api/admin/reports/${A}/schedule`, { schedule_type: 'weekly', schedule_time: '07:05', schedule_day: 3, is_active: true });
let next = new Date(r.json.nextRun);
ok('weekly: next run is a Wednesday 07:05 UTC in the future', r.json.success && next.getUTCDay() === 3 && next.getUTCHours() === 7 && next.getUTCMinutes() === 5 && next > new Date(), r.json);
r = await api('POST', `/api/admin/reports/${A}/schedule`, { schedule_type: 'monthly', schedule_time: '23:30', schedule_day: 31, is_active: true });
next = new Date(r.json.nextRun);
ok('monthly 31st: next run is on a 31st (short months skipped)', next.getUTCDate() === 31 && next.getUTCHours() === 23, r.json);
ok('stored next_run matches', q(`SELECT next_run FROM report_schedules WHERE report_id=${A}`)[0].next_run === r.json.nextRun);
r = await api('POST', `/api/admin/reports/${A}/schedule`, { schedule_type: 'daily', schedule_time: '09:00', is_active: false });
ok('inactive schedule: saved with no next run', r.json.success && r.json.nextRun === null && q(`SELECT next_run FROM report_schedules WHERE report_id=${A}`)[0].next_run === null, r.json);

// 4. Fire at the next whole minute (UTC): A active, B inactive, C deleted schedule, D deleted report
let fire = new Date(Date.now() + 60_000);
if (fire.getUTCSeconds() > 40) fire = new Date(fire.getTime() + 60_000);   // leave time to set up
fire.setUTCSeconds(0, 0);
const at = `${pad(fire.getUTCHours())}:${pad(fire.getUTCMinutes())}`;
const daily = (active) => ({ schedule_type: 'daily', schedule_time: at, is_active: active });
const [B, C, D] = [await newReport('ZZ sched B ' + Date.now()), await newReport('ZZ sched C ' + Date.now()), await newReport('ZZ sched D ' + Date.now())];
r = await api('POST', `/api/admin/reports/${A}/schedule`, daily(true));
ok('A: next run is the coming minute', r.json.nextRun === fire.toISOString(), { got: r.json.nextRun, want: fire.toISOString() });
await api('POST', `/api/admin/reports/${B}/schedule`, daily(false));
await api('POST', `/api/admin/reports/${C}/schedule`, daily(true));
ok('C: schedule deleted', (await api('DELETE', `/api/admin/reports/${C}/schedule`)).json.success);
await api('POST', `/api/admin/reports/${D}/schedule`, daily(true));
ok('D: report deleted', (await api('DELETE', `/api/admin/reports/${D}`)).json.success);
ok('D: deleted report has no next run', q(`SELECT next_run FROM report_schedules WHERE report_id=${D}`)[0].next_run === null);

console.log(`[schedule] waiting for ${at} UTC (${Math.round((fire - Date.now()) / 1000)}s)`);
await sleep(Math.max(0, fire - Date.now()) + 1000);
let runsA = [];
for (let i = 0; i < 90; i++) { runsA = scheduledRuns(A); if (runsA.length && runsA[0].status !== 'running') break; await sleep(1000); }
ok('A ran on schedule and completed', runsA.length === 1 && runsA[0].status === 'completed', runsA);
const outputs = runsA.length ? q(`SELECT file_type FROM report_outputs WHERE run_id='${runsA[0].run_id}'`) : [];
ok('A produced an HTML output', outputs.some(o => o.file_type === 'html'), outputs);
const schedA = q(`SELECT last_run, next_run FROM report_schedules WHERE report_id=${A}`)[0];
const tomorrow = new Date(fire.getTime() + 86_400_000).toISOString();
ok('A: last_run recorded, next_run is the same time tomorrow', schedA.last_run && schedA.next_run === tomorrow, { schedA, tomorrow });
ok('B (inactive) did not run', scheduledRuns(B).length === 0, scheduledRuns(B));
ok('C (schedule deleted) did not run', scheduledRuns(C).length === 0, scheduledRuns(C));
ok('D (report deleted) did not run', scheduledRuns(D).length === 0, scheduledRuns(D));
createdRuns.push(...runsA.map(x => x.run_id));

// 5. The run shows in the report's history as "scheduled"
const hist = await api('GET', `/api/admin/reports/${A}/runs`);
ok('run history lists the scheduled run', JSON.stringify(hist.json).includes('"scheduled"'), hist.json);

// Remove the rendered files this test created (the database is restored by the runner).
for (const id of createdRuns) fs.rmSync(path.join(ROOT, 'data', 'reports', 'runs', id), { recursive: true, force: true });
dropAdmin();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
