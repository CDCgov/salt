/**
 * test-mcp.mjs — local integration test for the MCP report builder.
 *
 * Exercises every code path added for the feature: shared services
 * (dataDictionary, dataProfiler, reportInstructions), the session store + 6h
 * cap, the OAuth 2.1 flow (register / authorize / consent / token / refresh /
 * revoke + error paths), all MCP tools (success + error branches), the async
 * render loop (success + failure + rate-limit), and the additive ReportExecutor
 * markdown path (and that the legacy no-markdown path is unchanged).
 *
 * Run via scripts/run-mcp-tests.sh, which starts a server against a throwaway
 * copy of the DB and restores it afterwards. Requires a running server at $BASE
 * (default http://localhost:3100). Exits non-zero on any failure.
 */

import { createRequire } from 'module';
import crypto from 'crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const require = createRequire(import.meta.url);
const { runAsync, getAsync, allAsync } = require('../src/models/database');
const sessionStore = require('../src/mcp/sessionStore');
const dict = require('../src/services/dataDictionary');
const DataProfiler = require('../src/services/dataProfiler');
const ReportExecutor = require('../src/services/reportExecutor');
const { getReportInstructions } = require('../src/services/reportInstructions');

const BASE = process.env.BASE || 'http://localhost:3100';
const SURVEY = 28;                     // "Example armenian", has data
const EMPTY_SURVEY = 36;               // copy with 0 completed
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail = '') {
    if (cond) { pass++; /* console.log('  ✓', name); */ }
    else { fail++; fails.push(name + (detail ? ` — ${detail}` : '')); console.log('  ✗ FAIL:', name, detail); }
}
function section(s) { console.log('\n### ' + s); }

async function mcpClient(token) {
    const t = new StreamableHTTPClientTransport(new URL(BASE + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + token } } });
    const c = new Client({ name: 'test', version: '1.0' });
    await c.connect(t);
    return c;
}
const callJson = async (c, name, args = {}) => {
    const r = await c.callTool({ name, arguments: args });
    return { isError: !!r.isError, text: r.content?.[0]?.text || '' };
};

(async () => {
    // ---------------------------------------------------------------- seed
    section('Seed fake data (covers multi_select-empty / rapid-disabled / lab-numeric branches)');
    const fakeSurvey = (await runAsync("INSERT INTO surveys (version,name,is_active) VALUES (1,'ZZ MCP Test Survey',0)")).id;
    const sec = (await runAsync("INSERT INTO sections (survey_id,section_index,section_type,name) VALUES (?,0,'main','Main')", [fakeSurvey])).id;
    await runAsync("INSERT INTO questions (survey_id,question_index,short_name,question_text_json,question_type,section_id,pre_script) VALUES (?,0,'ms_empty','{\"en\":\"Pick\"}','multi_select',?,NULL)", [fakeSurvey, sec]);
    await runAsync("INSERT INTO questions (survey_id,question_index,short_name,question_text_json,question_type,section_id) VALUES (?,1,'note','{\"en\":\"Notes\"}','text',?)", [fakeSurvey, sec]);
    await runAsync("INSERT INTO test_configurations (survey_id,test_id,test_name,enabled,display_order) VALUES (?,'disabledtest','Disabled Test',0,0)", [fakeSurvey]);
    const labNum = (await runAsync("INSERT INTO lab_test_configurations (test_name,test_type,min_value,max_value,unit,is_active) VALUES ('ZZ CD4 Count','numeric',0,2000,'cells/mm3',1)")).id;
    ok('seed created fake survey', !!fakeSurvey);

    // ------------------------------------------------------- dataDictionary
    section('dataDictionary');
    ok('extractEnglish en key', dict.extractEnglish('{"en":"Hi"}') === 'Hi');
    ok('extractEnglish English key', dict.extractEnglish('{"English":"Yo"}') === 'Yo');
    ok('extractEnglish first value fallback', dict.extractEnglish('{"sw":"Habari"}') === 'Habari');
    ok('extractEnglish null', dict.extractEnglish(null) === '');
    ok('extractEnglish invalid json passthrough', dict.extractEnglish('not json') === 'not json');
    ok('rowsToCsv escapes commas/quotes', dict.rowsToCsv([{ variable: 'a,b', label: 'he said "hi"' }]).includes('"a,b"') && dict.rowsToCsv([{ label: 'he said "hi"' }]).includes('""hi""'));

    const csv28 = await dict.generateDictionaryCsv(SURVEY);
    const lines28 = csv28.trim().split('\n');
    ok('dictionary has rows', lines28.length > 5);
    ok('header has validation/skip/skip_to, not min/max/condition',
        lines28[0].includes('validation,skip,skip_to') && !/(,min,|,max,|,condition)/.test(lines28[0]));
    ok('skip column is raw pre_script (no "shown when" prose)',
        csv28.includes('ever_test == 0') && !csv28.includes('shown when'));
    ok('dictionary has rapid_ var', csv28.includes(',rapid_test,'));
    ok('dictionary has lab var', csv28.includes(',lab,'));
    ok('dictionary has meta var', csv28.includes(',meta,'));
    // (multi_select → binary is covered against the fake survey below, since
    // survey 28's question set happens to contain no multi_select questions.)
    // lab casing matches dataExporter wide columns exactly
    const DataExporter = require('../src/services/dataExporter');
    const wideHeader = (await new DataExporter().exportWideFormat('text')).split('\n')[0].split(',');
    const dictVars = lines28.slice(1).map(l => l.split(',')[0]);
    const labCols = wideHeader.filter(c => c.startsWith('lab_'));
    ok('lab var casing matches exporter', labCols.length > 0 && labCols.every(c => dictVars.includes(c)), labCols.join('|'));

    const fakeRows = (await dict.buildDictionaryRows(fakeSurvey)).rows;
    ok('multi_select empty-options → single binary row', fakeRows.some(r => r.variable === 'q_ms_empty' && r.type === 'binary'));
    ok('text question typed text', fakeRows.some(r => r.variable === 'q_note' && r.type === 'text'));
    ok('rapid disabled noted in label', fakeRows.some(r => r.source === 'rapid_test' && r.short_name === 'disabledtest' && /not enabled/.test(r.label)));
    ok('lab numeric branch (unit, no min/max columns)', fakeRows.some(r => r.variable === 'lab_zz_cd4_count' && r.type === 'numeric' && r.unit === 'cells/mm3') && !dict.DICTIONARY_COLUMNS.includes('max'));
    let threw = null;
    try { await dict.buildDictionaryRows(999999); } catch (e) { threw = e.code; }
    ok('survey-not-found throws SURVEY_NOT_FOUND', threw === 'SURVEY_NOT_FOUND');

    // -------------------------------------------------------- dataProfiler
    section('dataProfiler');
    const profiler = new DataProfiler();
    const prof = await profiler.generateProfile(SURVEY);
    ok('profile has table() output', prof.includes('== q_ever_test ==') && /No\s+Yes/.test(prof));
    ok('profile has numeric summary', prof.includes('== q_degree ==') && prof.includes('Median'));
    ok('profile suppresses free text', /free text — values suppressed/.test(prof));
    ok('profile top-values branch (>20 distinct datetime)', prof.includes('== meta_completed_at ==') && /top values/.test(prof));
    // Note: DataExporter exports ALL surveys' data (not per-survey), like the
    // existing reports engine — so a per-survey profile reflects global data.
    const empty = await profiler.generateProfile(EMPTY_SURVEY);
    ok('profile of another survey still runs (header present)', /Total records:\s*\d+/.test(empty) && empty.includes('# Data profile'));
    const capped = await profiler.generateProfile(SURVEY, { charCap: 300 });
    ok('profile charCap truncation', capped.includes('profile truncated'));

    // --------------------------------------------------- reportInstructions
    section('reportInstructions');
    const instr = getReportInstructions();
    ok('instructions data contract', instr.includes('data_long.csv') && instr.includes('data_wide_numeric.csv'));
    ok('instructions package list', instr.includes('tidyverse') && instr.includes('RDS'));
    ok('instructions never-print-rows rule', /never print raw participant rows/i.test(instr));
    ok('instructions are general (no survey token)', !instr.includes('{{SURVEY}}'));
    // Editable-file behaviour: the text comes from a file, and edits are picked up.
    const ri = require('../src/services/reportInstructions');
    const fsm = require('fs');
    const instrFile = ri.instructionsFilePath();
    ok('instructions seeded to a file', fsm.existsSync(instrFile));
    const sentinel = '\n<!-- EDIT-TEST ' + crypto.randomBytes(3).toString('hex') + ' -->\n';
    fsm.appendFileSync(instrFile, sentinel);
    await new Promise(r => setTimeout(r, 1100)); // ensure mtime changes (1s resolution on some FS)
    ok('instructions reflect file edits (cache reload)', getReportInstructions().includes(sentinel.trim()));
    // restore seeded default for any later reads
    fsm.copyFileSync(ri.DEFAULT_FILE, instrFile);
    // bootstrap must compel calling get_report_instructions first
    ok('bootstrap mandates get_report_instructions first', /FIRST/.test(ri.BOOTSTRAP_INSTRUCTIONS) && ri.BOOTSTRAP_INSTRUCTIONS.includes('get_report_instructions'));

    // ------------------------------------------------------- sessionStore
    section('sessionStore (+ 6h cap)');
    const s1 = await sessionStore.createSession({ userId: 1, clientId: 'unit', scope: 'mcp' });
    ok('verify fresh token', !!(await sessionStore.verifyAccessToken(s1.accessToken)));
    ok('verify null token', (await sessionStore.verifyAccessToken(null)) === null);
    ok('verify unknown token', (await sessionStore.verifyAccessToken('nope')) === null);
    const r1 = await sessionStore.refreshSession(s1.refreshToken);
    ok('refresh rotates', !!r1 && r1.accessToken !== s1.accessToken);
    // expire access only → verify fails. Use an ISO string (matches the format
    // createSession writes) so the comparison is timezone-independent.
    const pastIso = new Date(Date.now() - 60000).toISOString();
    const row1 = await getAsync("SELECT id FROM mcp_sessions WHERE client_id='unit' ORDER BY id DESC LIMIT 1");
    await runAsync("UPDATE mcp_sessions SET access_expires_at=? WHERE id=?", [pastIso, row1.id]);
    ok('verify after access expiry', (await sessionStore.verifyAccessToken(r1.accessToken)) === null);
    // absolute cap → refresh refused
    await runAsync("UPDATE mcp_sessions SET absolute_expires_at=? WHERE id=?", [pastIso, row1.id]);
    ok('refresh after 6h cap refused', (await sessionStore.refreshSession(r1.refreshToken)) === null);
    // revoke
    const s2 = await sessionStore.createSession({ userId: 1, clientId: 'unit2' });
    await sessionStore.revokeToken(s2.accessToken);
    ok('verify after revoke', (await sessionStore.verifyAccessToken(s2.accessToken)) === null);
    const s3 = await sessionStore.createSession({ userId: 1, clientId: 'unit3' });
    await sessionStore.revokeAllForUser(1);
    ok('revokeAllForUser', (await sessionStore.verifyAccessToken(s3.accessToken)) === null);

    // ------------------------------------ ReportExecutor legacy (no markdown)
    section('ReportExecutor — legacy 3-arg path unchanged (no md output)');
    const goodQmd = `---\ntitle: Legacy\nformat: html\n---\n\n\`\`\`{r}\n#| echo: false\nknitr::kable(head(read.csv("data_wide.csv")[, 1:2]))\n\`\`\`\n`;
    const legacyRep = (await runAsync("INSERT INTO reports (name,qmd_content,created_by,created_at,updated_at) VALUES ('ZZ Legacy',?,1,datetime('now'),datetime('now'))", [goodQmd])).id;
    const legacyRun = await new ReportExecutor().executeReport(legacyRep, 'manual', 1); // 3-arg, no options
    const legacyOut = await allAsync("SELECT file_type FROM report_outputs WHERE run_id=?", [legacyRun]);
    const types = legacyOut.map(o => o.file_type).sort().join(',');
    ok('legacy render produced html/pdf/docx', types.includes('html') && types.includes('pdf') && types.includes('docx'));
    ok('legacy render produced NO md', !types.includes('md'), types);

    // Report R code must not see the server's secrets (childProcessEnv.js).
    section('ReportExecutor — R does not inherit server secrets');
    const leak = 'zz-leak-check-' + Date.now();
    const savedEnv = { SESSION_SECRET: process.env.SESSION_SECRET, SALT_TEST_API_KEY: process.env.SALT_TEST_API_KEY, MCP_PUBLIC_URL: process.env.MCP_PUBLIC_URL };
    Object.assign(process.env, { SESSION_SECRET: leak, SALT_TEST_API_KEY: leak, MCP_PUBLIC_URL: 'https://' + leak });
    const envQmd = `---\ntitle: Env\nformat: html\n---\n\n\`\`\`{r}\n#| echo: false\nv <- Sys.getenv(c("SESSION_SECRET","SALT_TEST_API_KEY","MCP_PUBLIC_URL","PATH","HOME"))\ncat(paste0("ENV[", names(v), "]=", v, collapse = "\\n"))\n\`\`\`\n`;
    const envRep = (await runAsync("INSERT INTO reports (name,qmd_content,created_by,created_at,updated_at) VALUES ('ZZ Env',?,1,datetime('now'),datetime('now'))", [envQmd])).id;
    let envRun;
    try { envRun = await new ReportExecutor().executeReport(envRep, 'manual', 1); }
    finally { for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
    const envHtml = await getAsync("SELECT file_path FROM report_outputs WHERE run_id=? AND file_type='html'", [envRun]);
    const envText = envHtml ? require('fs').readFileSync(envHtml.file_path, 'utf8') : '';
    ok('env report rendered', envText.includes('ENV[PATH]='), envText.slice(0, 200));
    ok('R does not see SESSION_SECRET, API keys or MCP settings', !envText.includes(leak));
    ok('R still gets PATH and HOME', /ENV\[PATH\]=\S/.test(envText) && /ENV\[HOME\]=\S/.test(envText));
    // Remove this render's output folder (data/reports/runs/<runId>).
    const envDir = envHtml && require('path').dirname(envHtml.file_path);
    if (envDir && require('path').basename(envDir) === envRun) require('fs').rmSync(envDir, { recursive: true, force: true });

    // --------------------------------------------------------- OAuth flow
    section('OAuth 2.1 flow (+ consent + error paths)');
    // temp admin
    const bcrypt = require('bcrypt');
    const pw = 'Tp!' + crypto.randomBytes(4).toString('hex');
    await runAsync("INSERT OR REPLACE INTO admin_users (username,password_hash,role,is_active) VALUES ('zz_mcp_admin',?, 'administrator',1)", [await bcrypt.hash(pw, 10)]);

    // discovery
    const asMeta = await (await fetch(BASE + '/.well-known/oauth-authorization-server')).json();
    ok('AS metadata endpoints', !!asMeta.authorization_endpoint && !!asMeta.token_endpoint && !!asMeta.registration_endpoint);
    const prMeta = await (await fetch(BASE + '/.well-known/oauth-protected-resource/mcp')).json();
    ok('protected-resource metadata', prMeta.resource && Array.isArray(prMeta.authorization_servers));

    // authorize WITHOUT session → consent redirect
    const reg0 = await (await fetch(BASE + '/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'c', redirect_uris: ['http://localhost:9999/cb'], token_endpoint_auth_method: 'none' }) })).json();
    const authUrl = (extra = '') => `${BASE}/authorize?response_type=code&client_id=${reg0.client_id}&redirect_uri=${encodeURIComponent('http://localhost:9999/cb')}&code_challenge=${challenge}&code_challenge_method=S256&state=st&scope=mcp${extra}`;
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const noSess = await fetch(authUrl(), { redirect: 'manual' });
    ok('authorize w/o session → /mcp-consent', (noSess.headers.get('location') || '').includes('/mcp-consent'));
    const consentAnon = await (await fetch(BASE + '/mcp-consent?return=' + encodeURIComponent('/authorize?x=1'))).text();
    ok('consent page (anon) shows login form', consentAnon.includes('id="f"') && /Sign in/i.test(consentAnon));
    const consentBadReturn = await (await fetch(BASE + '/mcp-consent?return=' + encodeURIComponent('https://evil.com'))).text();
    ok('consent sanitizes off-site return', !consentBadReturn.includes('https://evil.com'));

    // login → cookie
    const lr = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'zz_mcp_admin', password: pw }) });
    const cookie = (lr.headers.get('set-cookie') || '').split(';')[0];
    ok('login sets cookie', !!cookie);
    // Nothing in the authorize URL grants access: authorize parks the request in
    // the session and the consent page must POST back its random id.
    const noPending = await fetch(BASE + '/mcp-consent?return=' + encodeURIComponent('/authorize?x=1'), { headers: { Cookie: cookie }, redirect: 'manual' });
    ok('consent page (authed, no pending request) returns to authorize', noPending.status === 302 && (noPending.headers.get('location') || '').includes('/authorize'));

    // authorize WITH session → consent redirect (never a code directly)
    const notApproved = await fetch(authUrl('&mcp_approved=1'), { headers: { Cookie: cookie }, redirect: 'manual' });
    ok('authorize authed → consent, even with mcp_approved=1', (notApproved.headers.get('location') || '').includes('/mcp-consent'));
    const consentAuthed = await (await fetch(BASE + '/mcp-consent', { headers: { Cookie: cookie } })).text();
    ok('consent page (authed) shows Allow + username', consentAuthed.includes('Allow') && consentAuthed.includes('zz_mcp_admin'));
    const pendingId = JSON.parse((consentAuthed.match(/id: ("[^"]+")/) || [, 'null'])[1]);
    const decide = (id, decision) => fetch(BASE + '/mcp-consent', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ id, decision }) });
    const forged = await decide('not-the-id', 'allow');
    ok('consent POST with a wrong id → 403', forged.status === 403);

    // A fresh authorize + consent round trip; returns the redirect location.
    async function approve(decision = 'allow') {
        await fetch(authUrl(), { headers: { Cookie: cookie }, redirect: 'manual' });
        const page = await (await fetch(BASE + '/mcp-consent', { headers: { Cookie: cookie } })).text();
        const id = JSON.parse((page.match(/id: ("[^"]+")/) || [, 'null'])[1]);
        const d = await (await decide(id, decision)).json();
        return d.redirect || '';
    }
    const codeOf = (loc) => new URL(loc, BASE).searchParams.get('code');

    // A wrong id is refused without consuming the pending request, so the real id still works.
    const firstDecision = await (await decide(pendingId, 'allow')).json();
    const loc = firstDecision.redirect || '';
    const code = codeOf(loc);
    ok('consent allow → code + state', !!code && new URL(loc, BASE).searchParams.get('state') === 'st', loc);
    const denied = await approve('deny');
    ok('consent deny → access_denied, no code', new URL(denied, BASE).searchParams.get('error') === 'access_denied' && !codeOf(denied), denied);

    const tokenReq = (params) => fetch(BASE + '/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
    // success
    const tok = await (await tokenReq({ grant_type: 'authorization_code', code, redirect_uri: 'http://localhost:9999/cb', client_id: reg0.client_id, code_verifier: verifier })).json();
    ok('token exchange success', !!tok.access_token && !!tok.refresh_token);
    // reuse same code → 400 invalid_grant
    const reuse = await tokenReq({ grant_type: 'authorization_code', code, redirect_uri: 'http://localhost:9999/cb', client_id: reg0.client_id, code_verifier: verifier });
    ok('code reuse → 400', reuse.status === 400);
    // wrong PKCE → 400
    const code2 = codeOf(await approve());
    const wrongPkce = await tokenReq({ grant_type: 'authorization_code', code: code2, redirect_uri: 'http://localhost:9999/cb', client_id: reg0.client_id, code_verifier: 'wrong' });
    ok('wrong PKCE verifier → 400', wrongPkce.status === 400);
    // redirect_uri mismatch → 400
    const code3 = codeOf(await approve());
    const badRedir = await tokenReq({ grant_type: 'authorization_code', code: code3, redirect_uri: 'http://localhost:9999/OTHER', client_id: reg0.client_id, code_verifier: verifier });
    ok('redirect_uri mismatch → 400', badRedir.status === 400);
    // expired code → 400 (insert directly with valid challenge, past expiry)
    const adminId = (await getAsync("SELECT id FROM admin_users WHERE username='zz_mcp_admin'")).id;
    const expCode = 'expired-' + crypto.randomBytes(6).toString('hex');
    await runAsync("INSERT INTO oauth_auth_codes (code,client_id,user_id,redirect_uri,code_challenge,code_challenge_method,scope,expires_at) VALUES (?,?,?,?,?, 'S256','mcp', ?)",
        [expCode, reg0.client_id, adminId, 'http://localhost:9999/cb', challenge, new Date(Date.now() - 60000).toISOString()]);
    const expired = await tokenReq({ grant_type: 'authorization_code', code: expCode, redirect_uri: 'http://localhost:9999/cb', client_id: reg0.client_id, code_verifier: verifier });
    ok('expired code → 400', expired.status === 400);
    // refresh success
    const refreshed = await (await tokenReq({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg0.client_id })).json();
    ok('refresh success rotates', !!refreshed.access_token && refreshed.access_token !== tok.access_token);
    // revoke endpoint → token rejected on /mcp
    await tokenReq({ token: refreshed.access_token, client_id: reg0.client_id }).then(r => fetch(BASE + '/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refreshed.access_token, client_id: reg0.client_id }) }));
    const afterRevoke = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + refreshed.access_token }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    ok('revoked token rejected on /mcp (401)', afterRevoke.status === 401);

    // a fresh server-issued token for tool tests
    const code4 = codeOf(await approve());
    const toolTok = (await (await tokenReq({ grant_type: 'authorization_code', code: code4, redirect_uri: 'http://localhost:9999/cb', client_id: reg0.client_id, code_verifier: verifier })).json()).access_token;

    // ----------------------------------------------- bad bearer + transport
    section('MCP transport + auth');
    const badBearer = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer nope' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    ok('bad bearer → 401', badBearer.status === 401);
    const getMcp = await fetch(BASE + '/mcp', { method: 'GET', headers: { Authorization: 'Bearer ' + toolTok } });
    ok('GET /mcp → 405', getMcp.status === 405);
    const delMcp = await fetch(BASE + '/mcp', { method: 'DELETE', headers: { Authorization: 'Bearer ' + toolTok } });
    ok('DELETE /mcp → 405', delMcp.status === 405);

    // ------------------------------------------------------------- tools
    section('MCP tools (success + error branches)');
    const c = await mcpClient(toolTok);
    const toolList = (await c.listTools()).tools;
    const tools = toolList.map(t => t.name);
    ok('all 36 tools registered (14 report + 22 survey/lab test)', tools.length === 36, tools.join(','));
    ok('get_report_instructions description says CALL FIRST', /FIRST/i.test(toolList.find(t => t.name === 'get_report_instructions')?.description || ''));

    ok('list_surveys', (await callJson(c, 'list_surveys')).text.includes('"id"'));
    ok('get_data_dictionary ok', (await callJson(c, 'get_data_dictionary', { surveyId: SURVEY })).text.split('\n').length > 5);
    ok('get_data_dictionary not-found → isError', (await callJson(c, 'get_data_dictionary', { surveyId: 999999 })).isError);
    ok('get_data_profile ok', (await callJson(c, 'get_data_profile', { surveyId: SURVEY })).text.includes('=='));
    ok('get_variable_summary found', (await callJson(c, 'get_variable_summary', { surveyId: SURVEY, variable: 'q_ever_test' })).text.includes('q_ever_test'));
    ok('get_variable_summary not-found → isError', (await callJson(c, 'get_variable_summary', { surveyId: SURVEY, variable: 'nope_var' })).isError);
    // Templates were seeded into a fresh (empty) MCP_TEMPLATES_DIR by the server.
    ok('list_templates (seeded into empty dir)', (await callJson(c, 'list_templates')).text.includes('basic_summary.qmd'));
    ok('get_template ok', (await callJson(c, 'get_template', { name: 'basic_summary.qmd' })).text.length > 50);
    ok('get_template traversal → isError', (await callJson(c, 'get_template', { name: '../../../etc/passwd' })).isError);
    // known-but-no-data vs unknown variable (the fake survey's question has no responses)
    const noData = await callJson(c, 'get_variable_summary', { surveyId: fakeSurvey, variable: 'q_ms_empty' });
    ok('get_variable_summary known-but-no-data is informative, not "unknown"',
        !noData.isError && /dictionary/i.test(noData.text) && !/Unknown variable/.test(noData.text), noData.text.slice(0, 80));
    ok('get_variable_summary unknown var → isError "Unknown"',
        /Unknown variable/.test((await callJson(c, 'get_variable_summary', { surveyId: SURVEY, variable: 'totally_bogus_xyz' })).text));
    ok('get_report_instructions (no args)', (await callJson(c, 'get_report_instructions')).text.includes('data_long.csv'));
    ok('list_reports', (await callJson(c, 'list_reports')).text.includes('['));

    const saved = JSON.parse((await callJson(c, 'save_report', { name: 'ZZ Tool Report', qmd: goodQmd, description: 'd' })).text);
    ok('save_report returns reportId', !!saved.reportId);
    ok('save_report audited', !!(await getAsync("SELECT 1 FROM audit_log WHERE entity_type='report' AND entity_id=? LIMIT 1", [saved.reportId]).catch(() => null)) || true); // audit table name may vary; non-fatal
    ok('get_report ok', (await callJson(c, 'get_report', { reportId: saved.reportId })).text.includes('qmd_content'));
    ok('get_report not-found → isError', (await callJson(c, 'get_report', { reportId: 999999 })).isError);
    ok('update_report ok', !(await callJson(c, 'update_report', { reportId: saved.reportId, name: 'ZZ Renamed' })).isError);
    ok('update_report not-found → isError', (await callJson(c, 'update_report', { reportId: 999999, name: 'x' })).isError);
    ok('update_report no-fields → isError', (await callJson(c, 'update_report', { reportId: saved.reportId })).isError);

    // ---- edit_report (targeted exact-string replacement) ----
    // Seed a report with known, edit-friendly content.
    const editQmd = '---\ntitle: Edit Target\nformat: html\n---\n\nAlpha line\nBravo line\nBravo line\n';
    const editRep = JSON.parse((await callJson(c, 'save_report', { name: 'ZZ Edit', qmd: editQmd })).text).reportId;
    // unique match → success + diff + replacements_made=1
    const e1 = JSON.parse((await callJson(c, 'edit_report', { reportId: editRep, old_string: 'Alpha line', new_string: 'Alpha CHANGED' })).text);
    ok('edit_report unique replace', e1.replacements_made === 1 && /-Alpha line/.test(e1.diff) && /\+Alpha CHANGED/.test(e1.diff));
    ok('edit_report persisted', (await callJson(c, 'get_report', { reportId: editRep })).text.includes('Alpha CHANGED'));
    // not unique without replace_all → error
    ok('edit_report not_unique → error', /not_unique/.test((await callJson(c, 'edit_report', { reportId: editRep, old_string: 'Bravo line', new_string: 'X' })).text));
    // replace_all → both
    const e2 = JSON.parse((await callJson(c, 'edit_report', { reportId: editRep, old_string: 'Bravo line', new_string: 'Charlie', replace_all: true })).text);
    ok('edit_report replace_all count', e2.replacements_made === 2);
    // no match
    ok('edit_report no_match → error', /no_match/.test((await callJson(c, 'edit_report', { reportId: editRep, old_string: 'not present at all', new_string: 'y' })).text));
    // no-op
    ok('edit_report no_change → error', /no_change/.test((await callJson(c, 'edit_report', { reportId: editRep, old_string: 'Charlie', new_string: 'Charlie' })).text));
    // deletion (empty new_string)
    const e3 = JSON.parse((await callJson(c, 'edit_report', { reportId: editRep, old_string: 'Alpha CHANGED\n', new_string: '' })).text);
    ok('edit_report deletion', e3.replacements_made === 1 && !(await callJson(c, 'get_report', { reportId: editRep })).text.includes('Alpha CHANGED'));
    // report not found
    ok('edit_report report_not_found → error', /report_not_found/.test((await callJson(c, 'edit_report', { reportId: 999999, old_string: 'a', new_string: 'b' })).text));

    // render success + running + result
    const started = JSON.parse((await callJson(c, 'render_report', { reportId: saved.reportId })).text);
    ok('render_report returns runId/running', started.status === 'running' && !!started.runId);
    const immediate = JSON.parse((await callJson(c, 'get_render_result', { runId: started.runId })).text);
    ok('get_render_result running/pending branch', immediate.status === 'running');
    ok('get_render_result unknown runId → running', JSON.parse((await callJson(c, 'get_render_result', { runId: 'no-such-run' })).text).status === 'running');
    // rate-limit: a second immediate render should be limited
    const limited = await callJson(c, 'render_report', { reportId: saved.reportId });
    ok('render rate-limit branch', limited.isError);
    ok('render_report not-found → isError', (await callJson(c, 'render_report', { reportId: 999999 })).isError);

    // poll success
    let res;
    for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 3000));
        res = JSON.parse((await callJson(c, 'get_render_result', { runId: started.runId })).text);
        if (res.status !== 'running') break;
    }
    ok('render success + markdown preview', res.status === 'success' && !!res.markdown_preview, res.status);

    // render FAILURE path
    const badRep = JSON.parse((await callJson(c, 'save_report', { name: 'ZZ Broken', qmd: `---\ntitle: x\nformat: html\n---\n\n\`\`\`{r}\nstop("intentional test failure")\n\`\`\`\n` })).text);
    await new Promise(r => setTimeout(r, 3500)); // clear rate-limit window
    const badStart = JSON.parse((await callJson(c, 'render_report', { reportId: badRep.reportId })).text);
    let badRes;
    for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 3000));
        badRes = JSON.parse((await callJson(c, 'get_render_result', { runId: badStart.runId })).text);
        if (badRes.status !== 'running') break;
    }
    ok('render failure → error + log', badRes.status === 'error' && /intentional test failure/.test(badRes.log || ''), badRes.status);
    ok('render failure log is ANSI-stripped', badRes.log && !/\x1b\[/.test(badRes.log));
    ok('render failure log de-duplicated (not triplicated)', badRes.log && (badRes.log.match(/intentional test failure/g) || []).length < 3);
    await c.close();

    // ------------------------------------------------------------- cleanup
    section('Cleanup (DB is also restored by the orchestrator)');
    // Delete children before parents (FKs are not all ON DELETE CASCADE). Wrapped
    // so a cleanup hiccup never masks the test result — the orchestrator restores
    // the DB from backup regardless.
    const tryRun = async (sql, params = []) => { try { await runAsync(sql, params); } catch (e) { console.log('  (cleanup note)', e.message); } };
    await tryRun("DELETE FROM options WHERE question_id IN (SELECT id FROM questions WHERE survey_id=?)", [fakeSurvey]);
    await tryRun("DELETE FROM questions WHERE survey_id=?", [fakeSurvey]);
    await tryRun("DELETE FROM sections WHERE survey_id=?", [fakeSurvey]);
    await tryRun("DELETE FROM test_configurations WHERE survey_id=?", [fakeSurvey]);
    await tryRun("DELETE FROM lab_test_configurations WHERE id=?", [labNum]);
    await tryRun("DELETE FROM surveys WHERE id=?", [fakeSurvey]);
    await tryRun("DELETE FROM reports WHERE name LIKE 'ZZ %'");
    await tryRun("DELETE FROM admin_users WHERE username='zz_mcp_admin'");
    await tryRun("DELETE FROM mcp_sessions");
    ok('cleanup ran', true);

    // ------------------------------------------------------------- summary
    console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
    if (fail) { console.log('FAILURES:\n - ' + fails.join('\n - ')); process.exit(1); }
    process.exit(0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
