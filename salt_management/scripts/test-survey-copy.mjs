/**
 * test-survey-copy.mjs — the web editor's "copy survey" and "new version"
 * keep everything: settings, sections, questions (min/max, skip-to), options,
 * messages, rapid tests and audio. Compares source and copy field by field.
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
const q = (s) => { const t = execFileSync('sqlite3', ['-json', DB, s]).toString().trim(); return t ? JSON.parse(t) : []; };
let cookie = '', pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) pass++; else { fail++; console.log('FAIL', n, JSON.stringify(d ?? '').slice(0, 600)); } };
const api = async (m, p, b) => { const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b && JSON.stringify(b) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; return { status: r.status, json: await r.json().catch(() => null) }; };
const profile = (id) => ({
  questions: q(`SELECT short_name, question_index, question_type, min_selections, max_selections, COALESCE(skip_to_script,'') sts, COALESCE(skip_to_target,'') stt, COALESCE(pre_script,'') ps, COALESCE(validation_script,'') vs, LENGTH(audio_files_json) al FROM questions WHERE survey_id=${id} ORDER BY question_index, short_name`),
  options: q(`SELECT q.short_name, o.option_index, o.option_text_json, o.is_other, LENGTH(o.audio_files_json) al FROM options o JOIN questions q ON q.id=o.question_id WHERE q.survey_id=${id} ORDER BY 1,2`),
  sections: q(`SELECT section_type, name FROM sections WHERE survey_id=${id} ORDER BY section_index`),
  sectionOf: q(`SELECT q.short_name, s.section_type FROM questions q JOIN sections s ON s.id=q.section_id WHERE q.survey_id=${id} ORDER BY 1`),
  messages: q(`SELECT message_key, message_text_json, LENGTH(audio_files_json) al FROM survey_messages WHERE survey_id=${id} ORDER BY 1`),
  tests: q(`SELECT test_id, test_name, enabled, display_order FROM test_configurations WHERE survey_id=${id} ORDER BY test_id`),
  settings: q(`SELECT eligibility_script, coupon_count_script, eligibility_message_json, fingerprint_enabled, re_enrollment_days, staff_validation_message_json, hiv_rapid_test_enabled, contact_info_enabled, staff_eligibility_screening, rapid_test_samples_after_eligibility, payment_audit_phone_enabled FROM surveys WHERE id=${id}`)[0],
});

// A throwaway administrator for this run.
const ADMIN = 'zz_test_admin_' + process.pid;
const ADMIN_PW = 'Zz-' + Date.now();
execFileSync('sqlite3', [DB, `INSERT OR REPLACE INTO admin_users (username, password_hash, role, is_active)
    VALUES ('${ADMIN}', '${await bcrypt.hash(ADMIN_PW, 10)}', 'administrator', 1)`]);
const dropAdmin = () => execFileSync('sqlite3', [DB, `DELETE FROM admin_users WHERE username = '${ADMIN}'`]);
await api('POST', '/api/auth/login', { username: ADMIN, password: ADMIN_PW });
// Source: the survey with the most skip-to targets, made richer so every field is exercised.
const src = (q(`SELECT survey_id id FROM questions WHERE COALESCE(skip_to_target,'') != '' GROUP BY survey_id ORDER BY COUNT(*) DESC LIMIT 1`)[0]
    || q(`SELECT survey_id id FROM questions GROUP BY survey_id HAVING COUNT(*) >= 2 ORDER BY survey_id LIMIT 1`)[0]).id;
const firstTwo = q(`SELECT id, short_name FROM questions WHERE survey_id=${src} ORDER BY question_index LIMIT 2`);
const msq = firstTwo[0].id;
// Make sure the source has a skip-to rule to copy.
execFileSync('sqlite3', [DB, `UPDATE questions SET skip_to_script='true', skip_to_target='${firstTwo[1].short_name}' WHERE id=${msq} AND COALESCE(skip_to_target, '') = ''`]);
execFileSync('sqlite3', [DB, `UPDATE questions SET min_selections=1, max_selections=2, audio_files_json='{"English":"data:audio/mp3;base64,AAAA"}' WHERE id=${msq};
  UPDATE surveys SET contact_info_enabled=1, staff_eligibility_screening=1, payment_audit_phone_enabled=1, coupon_count_script='facility_coupons', is_draft=0 WHERE id=${src};
  INSERT OR IGNORE INTO test_configurations (survey_id, test_id, test_name, enabled, display_order) VALUES (${src}, 'zzcopy', 'ZZ copy test', 1, 5);
  INSERT OR IGNORE INTO survey_messages (survey_id, message_key, message_text_json, audio_files_json) VALUES (${src}, 'zz_copy_msg', '{"English":"m"}', '{"English":"data:audio/mp3;base64,AAAA"}');`]);
const P = profile(src);
const srcRow = q(`SELECT * FROM surveys WHERE id=${src}`)[0];
ok('source has skip-to, min/max, rapid tests, messages, audio', P.questions.some(x => x.stt) && P.questions.some(x => x.min_selections) && P.tests.length && P.messages.length && P.questions.some(x => x.al > 2), P);

// 1. Copy survey (Surveys page "Clone" / New Survey "based on")
let r = await api('POST', '/api/admin/survey-config', { name: 'ZZ web copy ' + Date.now(), description: 'Cloned survey', basedOnSurveyId: src });
ok('copy returns 201 with id and version 1', r.status === 201 && r.json.id && r.json.version === 1, r);
const C = r.json.id;
const PC = profile(C);
for (const k of Object.keys(P)) ok(`copy keeps ${k}`, JSON.stringify(PC[k]) === JSON.stringify(P[k]), { src: P[k], copy: PC[k] });
const cRow = q(`SELECT * FROM surveys WHERE id=${C}`)[0];
ok('copy is a separate inactive non-draft survey', cRow.is_active === 0 && cRow.is_draft === 0 && cRow.base_survey_id === C && cRow.parent_survey_id === null && cRow.version === 1, cRow);
ok('copy uses the given name/description and the source languages', cRow.description === 'Cloned survey' && cRow.languages === srcRow.languages && cRow.name.startsWith('ZZ web copy'), cRow);
r = await api('POST', '/api/admin/survey-config', { name: 'ZZ web copy langs ' + Date.now(), description: 'd', languages: '["English"]', basedOnSurveyId: src });
ok('copy with languages from the New Survey page', r.status === 201 && q(`SELECT languages FROM surveys WHERE id=${r.json.id}`)[0].languages === '["English"]', r);
r = await api('POST', '/api/admin/survey-config', { name: 'x', basedOnSurveyId: 999999 });
ok('copy of a missing survey is 404', r.status === 404, r);
r = await api('POST', '/api/admin/survey-config', { name: 'ZZ blank ' + Date.now() });
ok('blank survey still created with two sections', r.status === 201 && q(`SELECT COUNT(*) n FROM sections WHERE survey_id=${r.json.id}`)[0].n === 2, r);

// 2. New version (PUT with create_version on a non-draft survey)
r = await api('PUT', `/api/admin/survey-config/${src}`, { create_version: true, description: 'v-next', contact_info_enabled: 0 });
ok('new version returns id and version', r.status === 200 && r.json.newSurveyId && r.json.version > srcRow.version, r);
const V = r.json.newSurveyId;
const PV = profile(V);
for (const k of ['questions', 'options', 'sections', 'sectionOf', 'messages', 'tests']) ok(`version keeps ${k}`, JSON.stringify(PV[k]) === JSON.stringify(P[k]), { src: P[k], v: PV[k] });
ok('version applies changed settings, keeps the rest', PV.settings.contact_info_enabled === 0 && PV.settings.staff_eligibility_screening === 1 && PV.settings.coupon_count_script === 'facility_coupons', PV.settings);
const vRow = q(`SELECT * FROM surveys WHERE id=${V}`)[0];
ok('version lineage', vRow.base_survey_id === (srcRow.base_survey_id || src) && vRow.parent_survey_id === src && vRow.is_active === 0 && vRow.is_draft === 0 && vRow.description === 'v-next' && vRow.name === srcRow.name, vRow);
ok('audit entries', q(`SELECT COUNT(*) n FROM audit_log WHERE entity_id IN ('${C}','${V}') AND action IN ('CREATE_SURVEY','CREATE_SURVEY_VERSION')`)[0].n === 2);
dropAdmin();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
