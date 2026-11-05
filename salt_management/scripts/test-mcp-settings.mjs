/**
 * test-mcp-settings.mjs — integration test for the System page and the MCP
 * switches (SALT_IMPROVEMENT_PLAN.md item 3).
 *
 * Checks: defaults (report building off, survey editing on), the tool list
 * and instructions follow the switches without a restart, both off refuses
 * /mcp and the consent page, revoke-all signs every assistant out, the page
 * and its API are administrator-only, and changes are audited.
 *
 * Changes settings in the database it runs against: run via
 * scripts/run-mcp-tests.sh (throwaway copy) or against a scratch copy.
 */

import { createRequire } from 'module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const require = createRequire(import.meta.url);
const bcrypt = require('bcrypt');
const { runAsync, getAsync } = require('../src/models/database');
const sessionStore = require('../src/mcp/sessionStore');

const BASE = process.env.BASE || 'http://localhost:3100';
let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
    if (cond) pass++;
    else { fail++; console.log('  ✗ FAIL:', name, String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)); }
}
function section(s) { console.log('\n### ' + s); }

async function login(username, password) {
    const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    return (r.headers.get('set-cookie') || '').split(';')[0];
}
async function web(cookie, method, path, body) {
    const r = await fetch(BASE + path, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body && JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* html */ }
    return { status: r.status, text, json, location: r.headers.get('location') };
}
async function mcp(token) {
    const c = new Client({ name: 'test-settings', version: '1.0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(BASE + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
    return c;
}
async function tryMcp(token) {
    try { return { client: await mcp(token) }; } catch (e) { return { error: e }; }
}

(async () => {
    const pw = 'Zz-settings-' + Date.now();
    const hash = await bcrypt.hash(pw, 10);
    await runAsync("INSERT OR REPLACE INTO admin_users (username, password_hash, role, is_active) VALUES ('zz_sys_admin', ?, 'administrator', 1)", [hash]);
    await runAsync("INSERT OR REPLACE INTO admin_users (username, password_hash, role, is_active) VALUES ('zz_sys_staff', ?, 'lab_staff', 1)", [hash]);
    const adminId = (await getAsync("SELECT id FROM admin_users WHERE username = 'zz_sys_admin'")).id;
    const admin = await login('zz_sys_admin', pw);
    const staff = await login('zz_sys_staff', pw);
    const set = (key, value) => web(admin, 'POST', '/api/admin/system/settings', { key, value });

    section('Defaults');
    await runAsync('DELETE FROM system_settings').catch(() => {});
    await set('mcp_reports_enabled', false); // clears the server's cache
    await runAsync('DELETE FROM system_settings');
    let page = await web(admin, 'GET', '/admin/system');
    // describe() reads through the 5 s cache, so check the stored defaults directly too.
    const { getAll, clearCache } = require('../src/services/systemSettings');
    clearCache();
    const defaults = await getAll();
    ok('default: report building off, survey editing on', defaults.mcp_reports_enabled === false && defaults.mcp_survey_editing_enabled === true, defaults);
    ok('System page renders for an administrator', page.status === 200 && page.text.includes('AI report building (MCP)') && page.text.includes('Revoke all sessions'), page.status);
    ok('nav links to System', page.text.includes('href="/admin/system"'));

    section('Administrator only');
    const staffPage = await web(staff, 'GET', '/admin/system');
    ok('non-administrator cannot open the System page', staffPage.status !== 200 || !staffPage.text.includes('Revoke all sessions'), staffPage.status);
    const staffSet = await web(staff, 'POST', '/api/admin/system/settings', { key: 'mcp_reports_enabled', value: true });
    ok('non-administrator cannot change settings', staffSet.status === 401 || staffSet.status === 403 || staffSet.status === 302, staffSet.status);
    const anon = await web('', 'POST', '/api/admin/system/settings', { key: 'mcp_reports_enabled', value: true });
    ok('signed-out request cannot change settings', anon.status !== 200, anon.status);
    let bad = await set('nope', true);
    ok('unknown setting refused', bad.status === 400, bad.json);
    bad = await set('mcp_reports_enabled', 'yes');
    ok('non-boolean value refused', bad.status === 400, bad.json);

    const { accessToken } = await sessionStore.createSession({ userId: adminId, clientId: 'test-settings', scope: 'mcp' });
    const toolNames = async () => { const c = await mcp(accessToken); const t = (await c.listTools()).tools.map(x => x.name); const i = c.getInstructions(); await c.close(); return { t, i }; };

    section('Survey editing on, reports off (the default)');
    await set('mcp_reports_enabled', false); await set('mcp_survey_editing_enabled', true);
    let { t, i } = await toolNames();
    ok('survey tools offered', t.includes('add_question') && t.includes('get_survey_authoring_guide'));
    ok('report tools absent', !t.includes('get_report_instructions') && !t.includes('render_report'), t.join(','));
    ok('shared list_surveys offered', t.includes('list_surveys'));
    ok('instructions mention only survey editing', i.includes('get_survey_authoring_guide') && !i.includes('`get_report_instructions`') && /Report building is turned off/.test(i), i);
    let c = await mcp(accessToken);
    let r = await c.callTool({ name: 'render_report', arguments: { reportId: 1 } }).catch(e => ({ isError: true, content: [{ text: e.message }] }));
    ok('calling a report tool fails', r.isError, r);
    await c.close();

    section('Reports on, survey editing off — no restart');
    await set('mcp_reports_enabled', true); await set('mcp_survey_editing_enabled', false);
    ({ t, i } = await toolNames());
    ok('report tools offered', t.includes('get_report_instructions') && t.includes('render_report'));
    ok('survey tools absent', !t.includes('add_question') && !t.includes('copy_survey'), t.join(','));
    ok('instructions mention only reports', i.includes('get_report_instructions') && !i.includes('`get_survey_authoring_guide`'), i);
    c = await mcp(accessToken);
    r = await c.callTool({ name: 'copy_survey', arguments: { surveyId: 1 } }).catch(e => ({ isError: true, content: [{ text: e.message }] }));
    ok('calling a survey tool fails', r.isError, r);
    await c.close();

    section('Both on');
    await set('mcp_survey_editing_enabled', true);
    ({ t } = await toolNames());
    ok('all 36 tools offered', t.length === 36, t.length);

    section('Both off');
    await set('mcp_reports_enabled', false); await set('mcp_survey_editing_enabled', false);
    const raw = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + accessToken },
        body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }) });
    const rawJson = await raw.json().catch(() => null);
    ok('/mcp refuses with a JSON-RPC error', raw.status === 403 && rawJson?.error?.message?.includes('turned off') && rawJson.id === 7, rawJson);
    const both = await tryMcp(accessToken);
    ok('MCP client cannot connect', !!both.error);
    const consent = await web(admin, 'GET', '/mcp-consent');
    ok('consent page says AI assistants are turned off', consent.status === 200 && /turned off both/.test(consent.text) && !consent.text.includes('id="allow"'), consent.text.slice(0, 300));
    ok('Reports page shows report building is off', (await web(admin, 'GET', '/reports')).text.includes('AI report building is turned off'));

    section('Revoke all sessions');
    await set('mcp_reports_enabled', true);
    const second = await sessionStore.createSession({ userId: adminId, clientId: 'test-settings-2', scope: 'mcp' });
    page = await web(admin, 'GET', '/admin/system');
    const shown = Number((page.text.match(/id="sessionCount">(\d+)</) || [])[1]);
    ok('page shows the active session count', shown >= 2, shown);
    const rev = await web(admin, 'POST', '/api/admin/system/mcp/revoke-sessions');
    ok('revoke-all reports how many were active', rev.status === 200 && rev.json.revoked >= 2, rev.json);
    const after1 = await tryMcp(accessToken), after2 = await tryMcp(second.accessToken);
    ok('revoked tokens no longer work', !!after1.error && !!after2.error);
    ok('no active sessions left', (await sessionStore.countActiveSessions()) === 0);
    const staffRevoke = await web(staff, 'POST', '/api/admin/system/mcp/revoke-sessions');
    ok('non-administrator cannot revoke', staffRevoke.status !== 200, staffRevoke.status);

    section('Audit');
    const audits = await getAsync("SELECT COUNT(*) n FROM audit_log WHERE action = 'UPDATE_SYSTEM_SETTING' AND user_id = ?", [String(adminId)]);
    ok('setting changes audited with the user', audits.n >= 8, audits.n);
    const revAudit = await getAsync("SELECT new_value FROM audit_log WHERE action = 'REVOKE_ALL_MCP_SESSIONS' ORDER BY id DESC LIMIT 1");
    ok('revoke-all audited', revAudit && /"revoked":/.test(revAudit.new_value), revAudit);
    const last = await getAsync("SELECT old_value, new_value FROM audit_log WHERE action = 'UPDATE_SYSTEM_SETTING' ORDER BY id DESC LIMIT 1");
    ok('audit has old and new value', /"value":false/.test(last.old_value) && /"value":true/.test(last.new_value), last);

    // Leave both groups on for anything that runs after this.
    await set('mcp_survey_editing_enabled', true);
    await runAsync("DELETE FROM admin_users WHERE username IN ('zz_sys_admin', 'zz_sys_staff')");
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
