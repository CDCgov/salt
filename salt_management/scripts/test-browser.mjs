/**
 * test-browser.mjs — browser checks in real Chrome (Playwright, headless) for
 * the web pages behind SALT_IMPROVEMENT_PLAN.md items 1-4: the System page,
 * the AI Assistant dialog, the survey editor ("other" option, inline script
 * checks, Check survey), Edit Data, the lab test form, the consent page, and
 * that the Reports page icons load. Fails on unexpected console errors.
 *
 * Writes to the database it runs against, so run it via
 * `npm run test:browser` (throwaway copy) or against a scratch copy.
 * Env: BASE (default http://localhost:3100), SALT_DB_PATH (default
 * data/database/salt.db), PW_CHANNEL (browser channel, default "chrome";
 * set to "chromium" to use Playwright's own browser after
 * `npx playwright install chromium`), SHOTS (optional screenshot folder).
 * Needs the sqlite3 command-line tool.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const bcrypt = require('bcrypt');
const BASE = process.env.BASE || 'http://localhost:3100';
const DB = process.env.SALT_DB_PATH
    || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'database', 'salt.db');
const SHOTS = process.env.SHOTS || null;
const sql = (q) => execFileSync('sqlite3', [DB, q]).toString().trim();

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n, d === undefined ? '' : String(d).slice(0, 300)); } };

// Console errors that are expected: the server has no favicon, and the
// duplicate-short-name check below provokes a 409 on purpose.
const EXPECTED_CONSOLE = [/status of 404 .*@ \S*\/favicon\.ico/, /status of 409 .*@ \S*\/questions/, /already uses the short name/];

// ---- setup (API, as a throwaway administrator) ----------------------------
const ADMIN = 'zz_browser_admin_' + process.pid;
const ADMIN_PW = 'Zz-' + Date.now();
sql(`INSERT OR REPLACE INTO admin_users (username, password_hash, role, is_active)
     VALUES ('${ADMIN}', '${await bcrypt.hash(ADMIN_PW, 10)}', 'administrator', 1)`);
let cookie = '';
async function api(method, p, body, headers = {}) {
    const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', cookie, ...headers }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return r.json().catch(() => null);
}
await api('POST', '/api/auth/login', { username: ADMIN, password: ADMIN_PW });
await api('POST', '/api/admin/system/settings', { key: 'mcp_reports_enabled', value: false });
await api('POST', '/api/admin/system/settings', { key: 'mcp_survey_editing_enabled', value: true });
const SID = (await api('POST', '/api/admin/survey-config', { name: 'ZZ browser survey ' + Date.now(), languages: '["English"]' })).id;
const apiKey = sql('SELECT api_key FROM facilities ORDER BY id LIMIT 1');
const responseId = 'zz-browser-' + Date.now();
await api('POST', '/api/sync/survey/upload', {
    surveyId: responseId, subjectId: 'ZZB1', startDatetime: new Date().toISOString(), completedAt: new Date().toISOString(),
    language: 'English', serverSurveyId: SID, questions: [],
    answers: [{ questionId: 1, questionShortName: 'zz_color', answerValue: 2, answerType: 'multiple_choice', optionText: 'Other colour', otherText: 'teal' }],
    deviceInfo: { deviceId: 't', appVersion: 't', androidVersion: '15', deviceModel: 't' }, sampleCollected: null, testResults: [], paymentConfirmed: null
}, { Authorization: 'Bearer ' + apiKey });
const adminId = sql(`SELECT id FROM admin_users WHERE username = '${ADMIN}'`);
await require('../src/mcp/sessionStore').createSession({ userId: Number(adminId), clientId: 'zz-browser', scope: 'mcp' });

// ---- browser ---------------------------------------------------------------
const consoleErrors = [];
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
const page = await context.newPage();
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(`${page.url()} :: ${m.text()} @ ${m.location().url || ''}`); });
page.on('pageerror', e => consoleErrors.push(`${page.url()} :: PAGEERROR ${e.message}`));
const dialogs = [];
page.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const shot = (name) => SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : null;

try {
    console.log('\n### Login');
    await page.goto(BASE + '/login');
    await page.fill('input[name=username]', ADMIN);
    await page.fill('input[name=password]', ADMIN_PW);
    await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 10000 }), page.click('button[type=submit]')]);
    ok('login through the login page', !page.url().includes('/login'), page.url());

    console.log('\n### System page (item 3)');
    await page.click('nav >> text=System');
    await page.waitForURL('**/admin/system');
    ok('nav "System" opens /admin/system', page.url().endsWith('/admin/system'));
    const reportsSwitch = () => page.locator('input[data-key=mcp_reports_enabled]');
    ok('switches show the stored state', !(await reportsSwitch().isChecked()) && (await page.locator('input[data-key=mcp_survey_editing_enabled]').isChecked()));
    await page.locator('label.switch:has(input[data-key=mcp_reports_enabled])').click();
    await page.waitForFunction(() => document.getElementById('sysMsg').textContent.includes('Turned on'));
    ok('clicking a switch saves it', sql("SELECT value FROM system_settings WHERE key = 'mcp_reports_enabled'") === 'true');
    await page.reload();
    ok('switch state persists after reload', await reportsSwitch().isChecked());
    ok('shows who changed it', (await page.textContent('#meta_mcp_reports_enabled')).includes(`by ${ADMIN}`));
    await page.locator('label.switch:has(input[data-key=mcp_reports_enabled])').click();
    await page.waitForFunction(() => document.getElementById('sysMsg').textContent.includes('Turned off'));
    ok('switch back off', sql("SELECT value FROM system_settings WHERE key = 'mcp_reports_enabled'") === 'false');
    await page.click('button:has-text("Copy")');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    ok('Copy puts the connector URL on the clipboard', clip.endsWith('/mcp') && clip === await page.inputValue('#mcpUrl'), clip);
    const before = Number(await page.textContent('#sessionCount'));
    ok('shows connected sessions', before >= 1, before);
    dialogs.length = 0;
    await page.click('button:has-text("Revoke all sessions")');
    await page.waitForFunction(() => document.getElementById('sysMsg').textContent.includes('Revoked'));
    ok('revoke asks for confirmation', dialogs.some(d => /Sign out every connected AI assistant/.test(d)), dialogs.join('|'));
    ok('revoke-all clears the count', (await page.textContent('#sessionCount')) === '0');
    ok('no active sessions left', sql('SELECT COUNT(*) FROM mcp_sessions WHERE revoked = 0') === '0');
    await shot('system');

    console.log('\n### Reports page and AI Assistant dialog');
    await page.goto(BASE + '/reports');
    await page.waitForLoadState('networkidle');
    const icons = await page.evaluate(() => ({
        family: getComputedStyle(document.querySelector('i.fas')).fontFamily,
        loaded: [...document.fonts].some(f => /Font Awesome/.test(f.family) && f.status === 'loaded')
    }));
    ok('Reports page icons load (Font Awesome from cdnjs)', /Font Awesome/.test(icons.family) && icons.loaded, JSON.stringify(icons));
    await page.click('button:has-text("AI Assistant")');
    await page.waitForSelector('#aiBuilderModal', { state: 'visible' });
    const modal = await page.textContent('#aiBuilderModal');
    ok('AI Assistant dialog opens with the connector URL', modal.includes('Connector URL'));
    ok('dialog says report building is off and links to System',
        modal.includes('AI report building is turned off') && await page.locator('#aiBuilderModal a[href="/admin/system"]').count() === 1);
    await shot('reports-dialog');

    console.log('\n### Survey editor (items 1 and 4)');
    await page.goto(`${BASE}/surveys/${SID}/edit`);
    await page.click('button:has-text("New Question") >> nth=0');
    await page.waitForSelector('#editModal', { state: 'visible' });
    await page.fill('#shortName', 'zz_color');
    await page.selectOption('#questionType', 'multiple_choice');
    await page.locator('#languageTexts textarea').first().fill('Favourite colour?');
    for (let i = 0; i < 3; i++) await page.click('button:has-text("Add Option")');
    const optInputs = page.locator('#optionsList .option-text');
    await optInputs.nth(0).fill('Red'); await optInputs.nth(1).fill('Blue'); await optInputs.nth(2).fill('Other colour');
    const otherBoxes = page.locator('#optionsList .option-is-other');
    ok('each option has an "Other (free text)" checkbox', await otherBoxes.count() === 3);
    await otherBoxes.nth(2).check();
    await otherBoxes.nth(1).check();
    ok('ticking one "other" unticks the rest', (await otherBoxes.nth(1).isChecked()) && !(await otherBoxes.nth(2).isChecked()));
    await otherBoxes.nth(2).check();
    await page.fill('#preScript', 'zz_color = 1');
    await page.locator('#preScript').blur();
    await page.waitForSelector('#preScript + .jexl-check-result div', { timeout: 10000 });
    ok('item 1: inline error when the skip logic box loses focus', /Assignment/.test(await page.textContent('#preScript + .jexl-check-result')));
    await page.fill('#preScript', '');
    await page.locator('#preScript').blur();
    dialogs.length = 0;
    await Promise.all([page.waitForEvent('load'), page.click('#editModal button:has-text("Save")')]);
    ok('question saved', dialogs.some(d => /created successfully/.test(d)), dialogs.join('|'));
    const qid = sql(`SELECT id FROM questions WHERE survey_id = ${SID} AND short_name = 'zz_color'`);
    ok('other flag stored on option 3', sql(`SELECT group_concat(is_other) FROM (SELECT is_other FROM options WHERE question_id = ${qid} ORDER BY option_index)`) === '0,0,1');
    const list = await page.textContent('body'); // questions are listed per section
    ok('question list shows the "Other text: zz_color_other" tag', list.includes('Other text: zz_color_other'));
    ok('question list marks the option "(other, free text)"', list.includes('(other, free text)'));
    await page.click(`button[data-question-id="${qid}"]:has-text("Edit")`);
    await page.waitForSelector('#editModal', { state: 'visible' });
    ok('editing reloads the other checkbox state',
        JSON.stringify(await page.$$eval('#optionsList .option-is-other', els => els.map(e => e.checked))) === '[false,false,true]');
    await page.click('#editModal button:has-text("Cancel")');
    await page.click('button:has-text("New Question") >> nth=0');
    await page.fill('#shortName', 'zz_color');
    await page.selectOption('#questionType', 'text');
    await page.locator('#languageTexts textarea').first().fill('dup');
    dialogs.length = 0;
    await page.click('#editModal button:has-text("Save")');
    await page.waitForTimeout(1500);
    ok('duplicate short name: the editor shows the refusal', dialogs.some(d => /already uses the short name/.test(d)), dialogs.join('|'));
    await page.click('#editModal button:has-text("Cancel")');
    await page.click('button:has-text("Check survey")');
    await page.waitForFunction(() => {
        const t = (document.getElementById('surveyCheckResults')?.textContent || '').trim();
        return t.length > 0 && !/^Checking/.test(t);
    }, null, { timeout: 15000 });
    ok('item 1: Check survey shows results, including the blank-eligibility warning',
        /no eligibility script/.test(await page.textContent('#surveyCheckResults')), await page.textContent('#surveyCheckResults'));
    ok('System Messages include "Other, Specify Prompt"', (await page.content()).includes('Other, Specify Prompt'));
    await shot('editor');

    console.log('\n### Edit Data (item 4)');
    const csId = sql(`SELECT id FROM completed_surveys WHERE survey_response_id = '${responseId}'`);
    await page.goto(`${BASE}/edit-data/${csId}`);
    const body = await page.textContent('body');
    ok('Edit Data shows the other text', body.includes('q_zz_color_other') && body.includes('teal'));
    await page.locator('tr:has-text("q_zz_color") button:has-text("Edit")').first().click();
    await page.waitForSelector('#editOtherText', { state: 'visible' });
    ok('edit dialog has the other text field, filled in', (await page.inputValue('#editOtherText')) === 'teal');
    await page.fill('#editOtherText', 'turquoise');
    await Promise.all([page.waitForEvent('load'), page.click('#editSave')]);
    ok('saving stores the new text', sql(`SELECT response_other_text FROM survey_responses WHERE completed_survey_id = ${csId} AND question_short_name = 'zz_color'`) === 'turquoise');
    ok('page shows the new text', (await page.textContent('body')).includes('turquoise'));

    console.log('\n### Lab test form (item 1)');
    await page.goto(BASE + '/admin/lab-tests/new');
    await page.fill('#jexl_condition', 'nosuch_q == 1');
    await page.locator('#jexl_condition').blur();
    await page.waitForSelector('#jexl_condition + .jexl-check-result div', { timeout: 10000 }).catch(() => {});
    ok('lab test condition checked when the box loses focus',
        /Unknown variable "nosuch_q"/.test(await page.textContent('#jexl_condition + .jexl-check-result').catch(() => '')));

    console.log('\n### Consent page');
    await page.goto(BASE + '/mcp-consent');
    ok('consent page renders', (await page.textContent('h1')).includes('Connect your AI assistant to SALT'));

    const unexpected = consoleErrors.filter(e => !EXPECTED_CONSOLE.some(re => re.test(e)));
    ok('no unexpected console errors', unexpected.length === 0, unexpected.join('\n'));
} catch (err) {
    fail++;
    console.log('  ✗ HARNESS ERROR:', err.message.split('\n')[0]);
} finally {
    await browser.close();
    sql(`DELETE FROM admin_users WHERE username = '${ADMIN}'`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
