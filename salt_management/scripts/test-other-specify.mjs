/**
 * test-other-specify.mjs — integration test for "other, specify" options
 * (SALT_IMPROVEMENT_PLAN.md item 4) on the server: editor rules, versioning
 * and copy, export/import, data dictionary, tablet upload, long and wide
 * exports, Edit Data and its audit log.
 *
 * Writes to the database it runs against, so run it via
 * scripts/run-mcp-tests.sh (throwaway copy) or against a scratch copy.
 * Env: BASE (default http://localhost:3100), SALT_DB_PATH (default
 * data/database/salt.db). Needs the sqlite3 command-line tool.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const bcrypt = require('bcrypt');
const BASE = process.env.BASE || 'http://localhost:3100';
const DB = process.env.SALT_DB_PATH
    || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'database', 'salt.db');
let cookie = '';
let pass = 0, fail = 0;
const sql = (q) => execFileSync('sqlite3', ['-json', DB, q]).toString().trim();
const rows = (q) => { const t = sql(q); return t ? JSON.parse(t) : []; };
function check(name, cond, detail) {
    if (cond) { pass++; }
    else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)); }
}
async function api(method, path, body, headers = {}) {
    const r = await fetch(BASE + path, {
        method, headers: { 'Content-Type': 'application/json', cookie, ...headers },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
}

// A throwaway administrator for this run.
const ADMIN = 'zz_test_admin_' + process.pid;
const ADMIN_PW = 'Zz-' + Date.now();
execFileSync('sqlite3', [DB, `INSERT OR REPLACE INTO admin_users (username, password_hash, role, is_active)
    VALUES ('${ADMIN}', '${await bcrypt.hash(ADMIN_PW, 10)}', 'administrator', 1)`]);
const dropAdmin = () => execFileSync('sqlite3', [DB, `DELETE FROM admin_users WHERE username = '${ADMIN}'`]);
const API_KEY = rows('SELECT api_key FROM facilities ORDER BY id LIMIT 1')[0].api_key;

const opt = (i, en, isOther) => ({ option_index: i, text_json: { English: en }, audio_json: {}, ...(isOther ? { is_other: 1 } : {}) });
const q = (idx, short, type, options, extra = {}) => ({
    question_index: idx, short_name: short, question_text_json: { English: short + '?' },
    question_type: type, options, ...extra
});

await api('POST', '/api/auth/login', { username: ADMIN, password: ADMIN_PW });
const created = await api('POST', '/api/admin/survey-config', { name: 'Other test ' + Date.now(), languages: '["English"]' });
const SID = created.json.id;
check('create survey', created.status === 201 || created.status === 200, created.json);

// --- the tablet's post-login version check gets the required app version
{
    const vr = await fetch(`${BASE}/api/sync/survey/version`, { headers: { 'X-API-Key': API_KEY } });
    const vj = await vr.json();
    check('version check returns the required tablet app version', vr.status === 200 && vj.data.min_app_version_code === 4 && vj.data.min_app_version === '1.4', vj);
}

// --- editor routes
let r = await api('POST', `/api/admin/survey-config/${SID}/questions`, q(0, 'gender', 'multiple_choice', [opt(0, 'Male'), opt(1, 'Female'), opt(2, 'Other', true)]));
check('create MC with other', r.status === 201, r.json);
const genderId = r.json.id;
r = await api('POST', `/api/admin/survey-config/${SID}/questions`, q(1, 'drugs', 'multi_select', [opt(0, 'A'), opt(1, 'B'), opt(2, 'Other', true)], { min_selections: 1 }));
check('create multi-select with other', r.status === 201, r.json);
r = await api('POST', `/api/admin/survey-config/${SID}/questions`, q(2, 'two', 'multiple_choice', [opt(0, 'X', true), opt(1, 'Y', true)]));
check('reject two other options', r.status === 400 && /at most one/.test(r.json.error), r.json);
r = await api('POST', `/api/admin/survey-config/${SID}/questions`, q(2, 'num', 'numeric', [opt(0, 'X', true)]));
check('reject other on numeric', r.status === 400 && /Only multiple choice/.test(r.json.error), r.json);
r = await api('POST', `/api/admin/survey-config/${SID}/questions`, q(2, 'gender_other', 'text', []));
check('reject short_name = derived name', r.status === 400 && /reserved/.test(r.json.error), r.json);
r = await api('POST', `/api/admin/survey-config/${SID}/questions`, q(2, '_is_seed', 'text', []));
check('reject short_name starting with "_" (built-in variables)', r.status === 400 && /cannot start with "_"/.test(r.json.errors?.[0]?.msg), r.json);
r = await api('POST', `/api/admin/survey-config/${SID}/questions`, q(2, 'plain', 'multiple_choice', [opt(0, 'P'), opt(1, 'Q')]));
check('create MC without other', r.status === 201, r.json);
const plainId = r.json.id;
r = await api('POST', `/api/admin/survey-config/${SID}/questions`, q(3, 'plain_other', 'text', []));
check('allow plain_other when plain has no other option', r.status === 201, r.json);
r = await api('PUT', `/api/admin/survey-config/${SID}/questions/${plainId}`, { options: [opt(0, 'P'), opt(1, 'Q', true)] });
check('reject adding other when x_other exists', r.status === 400 && /already a question short name/.test(r.json.error), r.json);
r = await api('PUT', `/api/admin/survey-config/${SID}/questions/${genderId}`, { short_name: 'drugs_other' });
check('reject rename to another question\'s derived name', r.status === 400, r.json);
r = await api('PUT', `/api/admin/survey-config/${SID}/questions/${genderId}`, { question_type: 'numeric' });
check('reject type change to numeric while other option exists', r.status === 400, r.json);
r = await api('PUT', `/api/admin/survey-config/${SID}/questions/${genderId}`, q(0, 'gender', 'multiple_choice', [opt(0, 'Male'), opt(1, 'Female'), opt(2, 'Other', true)]));
check('update MC keeping other', r.status === 200, r.json);
let dbOpts = rows(`SELECT option_index, is_other FROM options WHERE question_id = ${genderId} ORDER BY option_index`);
check('DB: gender option 2 is_other', JSON.stringify(dbOpts.map(o => o.is_other)) === '[0,0,1]', dbOpts);

r = await api('GET', `/api/admin/survey-config/${SID}`);
const cfgGender = (r.json.questions || []).find(x => x.short_name === 'gender');
check('config GET returns is_other', cfgGender && cfgGender.options.some(o => o.is_other === 1), cfgGender && cfgGender.options);

r = await api('GET', `/surveys/${SID}/edit`);
check('editor page renders other tag + checkbox', r.status === 200 && r.text.includes('Other text: gender_other') && r.text.includes('option-is-other') && r.text.includes('other_specify_prompt'), r.status);

// --- versioning and copy keep is_other
r = await api('PUT', `/api/admin/survey-config/${SID}`, { description: 'v2', create_version: true });
const v2 = r.json.newSurveyId;
let n = rows(`SELECT COUNT(*) n FROM options o JOIN questions q ON q.id = o.question_id WHERE q.survey_id = ${v2} AND o.is_other = 1`)[0].n;
check('new version keeps is_other', n === 2, n);
r = await api('POST', '/api/admin/survey-config', { name: 'Other copy ' + Date.now(), basedOnSurveyId: SID });
n = rows(`SELECT COUNT(*) n FROM options o JOIN questions q ON q.id = o.question_id WHERE q.survey_id = ${r.json.id} AND o.is_other = 1`)[0].n;
check('survey copy keeps is_other', n === 2, n);

// --- export / import
r = await api('GET', `/api/admin/surveys/${SID}/export`);
const bundle = r.json;
check('bundle export includes is_other', bundle.options.filter(o => o.is_other === 1).length === 2, bundle.options);
r = await api('POST', '/api/admin/surveys/import', bundle);
const impId = r.json && (r.json.surveyId || (r.json.survey && r.json.survey.id) || r.json.id);
check('import bundle with is_other', r.status === 200 || r.status === 201, r.json);
n = rows(`SELECT COUNT(*) n FROM options o JOIN questions q ON q.id = o.question_id WHERE q.survey_id = (SELECT MAX(id) FROM surveys) AND o.is_other = 1`)[0].n;
check('imported survey has is_other', n === 2, { n, impId });
const old = JSON.parse(JSON.stringify(bundle));
old.options.forEach(o => { delete o.is_other; o.option_value = 'legacy'; });
r = await api('POST', '/api/admin/surveys/import', old);
n = rows(`SELECT COUNT(*) n FROM options o JOIN questions q ON q.id = o.question_id WHERE q.survey_id = (SELECT MAX(id) FROM surveys) AND o.is_other = 1`)[0].n;
check('old bundle (no is_other, has option_value) imports as normal options', (r.status === 200 || r.status === 201) && n === 0, { status: r.status, n, body: r.json });
const clash = JSON.parse(JSON.stringify(bundle));
clash.questions.find(x => x.short_name === 'plain_other').short_name = 'drugs_other';
r = await api('POST', '/api/admin/surveys/import', clash);
check('import refuses derived-name clash', r.status === 400 && /drugs_other/.test(r.json.message), r.json);
const two = JSON.parse(JSON.stringify(bundle));
const gq = two.questions.find(x => x.short_name === 'gender');
two.options.filter(o => o.question_id === gq.id).forEach(o => { o.is_other = 1; });
r = await api('POST', '/api/admin/surveys/import', two);
check('import refuses two other options', r.status === 400 && /at most one/.test(r.json.message), r.json);

// --- data dictionary
r = await api('GET', `/api/admin/export/data-dictionary?surveyId=${SID}`);
check('dictionary has q_gender_other', /q_gender_other,survey,gender,.*free text when option 2 ""Other"" is selected/.test(r.text), r.text.split('\n').filter(l => l.includes('other')));
check('dictionary has q_drugs_other', r.text.includes('q_drugs_other'), null);
check('dictionary has no q_plain_other derived entry', !/q_plain_other,survey,plain,/.test(r.text), null);

// --- upload
const subj = 'OT' + Date.now();
const mk = (id, answers) => ({
    surveyId: id, subjectId: subj, startDatetime: new Date().toISOString(), completedAt: new Date().toISOString(),
    language: 'English', serverSurveyId: SID, questions: [], answers,
    deviceInfo: { deviceId: 't', appVersion: 't', androidVersion: '15', deviceModel: 't' },
    sampleCollected: null, testResults: [], paymentConfirmed: null
});
const up1 = 'other-test-1-' + Date.now(), up2 = 'other-test-2-' + Date.now();
r = await api('POST', '/api/sync/survey/upload', mk(up1, [
    { questionId: 1, questionShortName: 'gender', answerValue: 2, answerType: 'multiple_choice', optionText: 'Other', otherText: '  nonbinary  ' },
    { questionId: 2, questionShortName: 'drugs', answerValue: '0,2', answerType: 'multi_select', otherText: 'kratom' },
    { questionId: 3, questionShortName: 'plain', answerValue: 0, answerType: 'multiple_choice', optionText: 'P' },
    { questionId: 4, questionShortName: 'plain_other', answerValue: 'real text q', answerType: 'text' }
]), { Authorization: 'Bearer ' + API_KEY });
check('upload with otherText', r.status === 200 || r.status === 201, r.json);
r = await api('POST', '/api/sync/survey/upload', mk(up2, [
    { questionId: 1, questionShortName: 'gender', answerValue: 0, answerType: 'multiple_choice', optionText: 'Male' },
    { questionId: 2, questionShortName: 'drugs', answerValue: '1', answerType: 'multi_select', otherText: '   ' }
]), { Authorization: 'Bearer ' + API_KEY });
check('upload without otherText (old app shape)', r.status === 200 || r.status === 201, r.json);
let stored = rows(`SELECT sr.question_short_name s, sr.response_other_text t FROM survey_responses sr JOIN completed_surveys cs ON cs.id = sr.completed_survey_id WHERE cs.survey_response_id IN ('${up1}','${up2}') ORDER BY cs.id, sr.question_short_name`);
const st = Object.fromEntries(stored.map((x, i) => [(i < 4 ? '1:' : '2:') + x.s, x.t]));
check('stored trimmed gender other text', st['1:gender'] === 'nonbinary', st);
check('stored multi-select other text', st['1:drugs'] === 'kratom', st);
check('no other text for plain / text questions', st['1:plain'] === null && st['1:plain_other'] === null, st);
check('blank other text stored as null; missing stays null', st['2:drugs'] === null && st['2:gender'] === null, st);

// --- exports
r = await api('GET', '/api/admin/export/long');
const longLines = r.text.split('\n');
const subjLong = longLines.filter(l => l.includes(up1) || l.includes(up2));
check('long export has q_gender_other row', subjLong.some(l => l.includes('q_gender_other') && l.includes('nonbinary')), subjLong.filter(l => l.includes('other')));
check('long export has q_drugs_other row', subjLong.some(l => l.includes('q_drugs_other') && l.includes('kratom')), null);
check('long export: no _other rows for second upload', !subjLong.some(l => l.includes(up2) && /q_(gender|drugs)_other/.test(l)), null);
for (const vt of ['text', 'numeric']) {
    r = await api('GET', '/api/admin/export/wide?valueType=' + vt);
    const [hdr, ...lines] = r.text.replace(/^﻿/, '').split('\n');
    const cols = hdr.split(',');
    const gi = cols.indexOf('q_gender'), goi = cols.indexOf('q_gender_other');
    const d2 = cols.indexOf('q_drugs_2'), doi = cols.indexOf('q_drugs_other');
    check(`wide(${vt}): q_gender_other right after q_gender`, gi >= 0 && goi === gi + 1, { gi, goi });
    check(`wide(${vt}): q_drugs_other after q_drugs_2`, d2 >= 0 && doi === d2 + 1, { d2, doi, around: cols.slice(d2 - 2, d2 + 3) });
    check(`wide(${vt}): real question plain_other keeps its own column`, cols.includes('q_plain_other'), null);
    const row1 = lines.find(l => l.includes(up1)) || '';
    check(`wide(${vt}): value present`, row1.split(',')[goi] === 'nonbinary' && row1.split(',')[doi] === 'kratom', row1);
}

// --- edit data
const csId = rows(`SELECT id FROM completed_surveys WHERE survey_response_id = '${up1}'`)[0].id;
r = await api('GET', `/edit-data/${csId}`);
check('Edit Data page shows other text', r.status === 200 && r.text.includes('q_gender_other') && r.text.includes('nonbinary'), r.status);
const ot = () => rows(`SELECT response_other_text t FROM survey_responses WHERE completed_survey_id = ${csId} AND question_short_name = 'gender'`)[0].t;
r = await api('PUT', `/api/admin/subjects/${csId}/responses/gender`, { optionIndex: 2, otherText: ' edited ' });
check('edit other text', r.status === 200 && ot() === 'edited', { r: r.json, t: ot() });
r = await api('PUT', `/api/admin/subjects/${csId}/responses/gender`, { optionIndex: 2 });
check('edit without otherText keeps it', ot() === 'edited', ot());
r = await api('PUT', `/api/admin/subjects/${csId}/responses/gender`, { optionIndex: 0, otherText: 'ignored' });
check('switching away from other clears text', r.status === 200 && ot() === null, ot());
r = await api('PUT', `/api/admin/subjects/${csId}/responses/gender`, { optionIndex: 2, otherText: 'back' });
r = await api('POST', `/api/admin/subjects/${csId}/responses/gender/clear`);
check('clear response clears other text', r.status === 200 && ot() === null, ot());
const otd = () => rows(`SELECT response_other_text t FROM survey_responses WHERE completed_survey_id = ${csId} AND question_short_name = 'drugs'`)[0].t;
r = await api('PUT', `/api/admin/subjects/${csId}/responses/drugs`, { optionIndices: [1, 2] });
check('multi-select edit keeping other keeps text', r.status === 200 && otd() === 'kratom', otd());
r = await api('PUT', `/api/admin/subjects/${csId}/responses/drugs`, { optionIndices: [1] });
check('multi-select edit unticking other clears text', otd() === null, otd());
r = await api('GET', '/edit-data/audit-log.csv');
check('audit log shows other text', r.text.includes('(other: edited)'), null);

dropAdmin();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
