/**
 * test-mcp-survey.mjs — integration test for the MCP survey and lab test
 * tools (SALT_IMPROVEMENT_PLAN.md item 2).
 *
 * Calls every survey/lab test tool over MCP against a running server and
 * checks the database afterwards: active surveys refused, expected_updated_at
 * guard, lab tests with results protected, audio validation, audit entries.
 *
 * Writes to the database it runs against, so run it via
 * scripts/run-mcp-tests.sh (throwaway copy) or against a scratch copy.
 * Requires a running server at $BASE with MCP enabled. Exits non-zero on failure.
 */

import { createRequire } from 'module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const require = createRequire(import.meta.url);
const { runAsync, getAsync, allAsync } = require('../src/models/database');
const sessionStore = require('../src/mcp/sessionStore');

const BASE = process.env.BASE || 'http://localhost:3100';

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
    if (cond) pass++;
    else { fail++; console.log('  ✗ FAIL:', name, typeof detail === 'string' ? detail.slice(0, 500) : JSON.stringify(detail).slice(0, 500)); }
}
function section(s) { console.log('\n### ' + s); }

async function call(c, name, args = {}) {
    const r = await c.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text || '';
    let data = null;
    try { data = JSON.parse(text); } catch { /* plain text */ }
    return { isError: !!r.isError, text, data };
}

// A minimal valid MP3: an MPEG-1 Layer III frame header followed by padding.
const MP3 = Buffer.concat([Buffer.from([0xFF, 0xFB, 0x90, 0x64]), Buffer.alloc(400)]).toString('base64');
const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]).toString('base64');

(async () => {
    const admin = await getAsync("SELECT id FROM admin_users WHERE role = 'administrator' AND is_active = 1 ORDER BY id LIMIT 1");
    const { accessToken } = await sessionStore.createSession({ userId: admin.id, clientId: 'test-survey', scope: 'mcp' });
    const transport = new StreamableHTTPClientTransport(new URL(BASE + '/mcp'),
        { requestInit: { headers: { Authorization: 'Bearer ' + accessToken } } });
    const c = new Client({ name: 'test-survey', version: '1.0' });
    await c.connect(transport);
    const startedAt = (await getAsync("SELECT datetime('now') t")).t;

    section('Tool list and guide');
    const tools = (await c.listTools()).tools.map(t => t.name);
    const expected = ['get_survey_authoring_guide', 'get_survey', 'check_survey', 'list_lab_tests', 'get_lab_test',
        'create_survey', 'copy_survey', 'replace_survey', 'update_survey_settings', 'add_question', 'update_question',
        'delete_question', 'move_question', 'set_options', 'update_section', 'set_message', 'set_audio', 'remove_audio',
        'create_lab_test', 'update_lab_test', 'deactivate_lab_test', 'reactivate_lab_test'];
    ok('all 22 survey/lab test tools registered', expected.every(t => tools.includes(t)), expected.filter(t => !tools.includes(t)).join(','));
    ok('no activation tool', !tools.some(t => /activate_survey/.test(t)));
    const guide = await call(c, 'get_survey_authoring_guide');
    ok('guide served', !guide.isError && guide.text.includes('## Workflow') && guide.text.includes('2 =~ q'));
    const list = await call(c, 'list_surveys');
    ok('list_surveys shows is_draft / updated_at / lineage', list.data && 'is_draft' in list.data[0] && 'updated_at' in list.data[0] && 'base_survey_id' in list.data[0]);

    section('Active survey is read-only');
    let active = await getAsync('SELECT id FROM surveys WHERE is_active = 1 ORDER BY id DESC LIMIT 1');
    if (!active) {
        const any = await getAsync('SELECT id FROM surveys ORDER BY id DESC LIMIT 1');
        await runAsync('UPDATE surveys SET is_active = 1 WHERE id = ?', [any.id]);
        active = any;
    }
    const A = active.id;
    const getA = await call(c, 'get_survey', { surveyId: A });
    ok('get_survey returns a bundle', getA.data && getA.data.schema_version === 1 && Array.isArray(getA.data.questions));
    ok('get_survey leaves audio out by default', !getA.text.includes('base64'));
    const firstQ = getA.data.questions[0];
    for (const [name, args] of [
        ['update_survey_settings', { surveyId: A, settings: { description: 'x' } }],
        ['add_question', { surveyId: A, question: { short_name: 'zz_x', question_type: 'text', question_text_json: { English: 'x' } } }],
        ['update_question', { surveyId: A, question: firstQ.id, changes: { pre_script: null } }],
        ['delete_question', { surveyId: A, question: firstQ.id }],
        ['set_message', { surveyId: A, message_key: 'staff_validation', text: { English: 'x' } }],
        ['set_audio', { surveyId: A, target: 'question', question: firstQ.id, language: 'English', mp3_base64: MP3 }],
        ['replace_survey', { surveyId: A, bundle: getA.data, expected_updated_at: getA.data.survey.updated_at }],
    ]) {
        const r = await call(c, name, args);
        ok(`${name} refused on the active survey`, r.isError && /is active/.test(r.text) && /copy_survey/.test(r.text), r.text);
    }
    ok('active survey unchanged', (await getAsync('SELECT COUNT(*) n FROM questions WHERE id = ?', [firstQ.id])).n === 1);

    section('copy_survey');
    const copy = await call(c, 'copy_survey', { surveyId: A });
    ok('copy_survey succeeds', !copy.isError && copy.data.surveyId, copy.text);
    const C = copy.data.surveyId;
    const cRow = await getAsync('SELECT * FROM surveys WHERE id = ?', [C]);
    const aRow = await getAsync('SELECT * FROM surveys WHERE id = ?', [A]);
    ok('copy is inactive', cRow.is_active === 0);
    ok('copy is a new version linked to the source', cRow.parent_survey_id === A && cRow.base_survey_id === (aRow.base_survey_id || A) && cRow.version > aRow.version, cRow);
    const counts = async (id) => ({
        q: (await getAsync('SELECT COUNT(*) n FROM questions WHERE survey_id = ?', [id])).n,
        o: (await getAsync('SELECT COUNT(*) n FROM options o JOIN questions q ON q.id = o.question_id WHERE q.survey_id = ?', [id])).n,
        m: (await getAsync('SELECT COUNT(*) n FROM survey_messages WHERE survey_id = ?', [id])).n,
        t: (await getAsync('SELECT COUNT(*) n FROM test_configurations WHERE survey_id = ?', [id])).n,
        audio: (await getAsync("SELECT SUM(LENGTH(audio_files_json)) n FROM questions WHERE survey_id = ?", [id])).n,
        skipTo: (await getAsync("SELECT COUNT(*) n FROM questions WHERE survey_id = ? AND COALESCE(skip_to_target, '') != ''", [id])).n,
    });
    ok('copy has everything (questions, options, messages, rapid tests, audio, skip-to)', JSON.stringify(await counts(C)) === JSON.stringify(await counts(A)),
        JSON.stringify({ A: await counts(A), C: await counts(C) }));
    const named = await call(c, 'copy_survey', { surveyId: A, name: 'ZZ MCP named copy' });
    const nRow = await getAsync('SELECT * FROM surveys WHERE id = ?', [named.data.surveyId]);
    ok('copy with a new name starts a separate survey', nRow.name === 'ZZ MCP named copy' && nRow.base_survey_id === nRow.id && nRow.parent_survey_id === A, nRow);

    section('check_survey');
    const chk = await call(c, 'check_survey', { surveyId: C });
    ok('check_survey returns errors, warnings and an audio summary', chk.data && Array.isArray(chk.data.errors) && Array.isArray(chk.data.warnings) && chk.data.audio && 'total_mb' in chk.data.audio, chk.text);

    section('Questions');
    const lang = JSON.parse(cRow.languages || '["English"]')[0];
    const txt = (s) => ({ [lang]: s });
    const before = await getAsync('SELECT updated_at FROM surveys WHERE id = ?', [C]);
    await runAsync("UPDATE surveys SET updated_at = '2001-01-01 00:00:00' WHERE id = ?", [C]);
    const add = await call(c, 'add_question', { surveyId: C, position: 0, question: {
        short_name: 'zz_q1', question_type: 'multiple_choice', question_text_json: txt('Pick one'),
        options: [{ text: txt('Yes') }, { text: txt('No') }, { text: txt('Other') , is_other: true }] } });
    ok('add_question succeeds with a check', !add.isError && add.data.questionId && add.data.jexl_check, add.text);
    const q1 = await getAsync('SELECT * FROM questions WHERE id = ?', [add.data.questionId]);
    ok('inserted at position 0, others moved down', q1.question_index === 0 &&
        (await getAsync('SELECT COUNT(*) n FROM questions WHERE survey_id = ? AND question_index = 0', [C])).n === 1);
    ok('other option stored', (await getAsync('SELECT is_other FROM options WHERE question_id = ? AND option_index = 2', [q1.id])).is_other === 1);
    ok('defaults to the main section', (await getAsync('SELECT section_type FROM sections WHERE id = ?', [q1.section_id])).section_type === 'main');
    ok('updated_at bumped', (await getAsync('SELECT updated_at FROM surveys WHERE id = ?', [C])).updated_at > '2001-01-01 00:00:00');
    let r = await call(c, 'add_question', { surveyId: C, question: { short_name: 'zz_q1', question_type: 'text', question_text_json: txt('x') } });
    ok('duplicate short name refused', r.isError && /already uses the short name/.test(r.text), r.text);
    r = await call(c, 'add_question', { surveyId: C, question: { short_name: 'value', question_type: 'text', question_text_json: txt('x') } });
    ok('reserved short name refused', r.isError && /reserved/.test(r.text), r.text);
    r = await call(c, 'add_question', { surveyId: C, question: { short_name: 'zz_q1_other', question_type: 'text', question_text_json: txt('x') } });
    ok('<short>_other name refused', r.isError && /reserved for the "other" text/.test(r.text), r.text);
    r = await call(c, 'add_question', { surveyId: C, question: { short_name: 'zz_two', question_type: 'multiple_choice', question_text_json: txt('x'),
        options: [{ text: txt('a'), is_other: true }, { text: txt('b'), is_other: true }] } });
    ok('two other options refused', r.isError && /at most one/.test(r.text), r.text);

    r = await call(c, 'update_question', { surveyId: C, question: 'zz_q1', changes: { pre_script: 'zz_q1 = 1' } });
    ok('assignment saved but reported as an error', !r.isError && r.data.jexl_check.errors.some(e => /Assignment/.test(e.message)), r.text);
    r = await call(c, 'update_question', { surveyId: C, question: 'zz_q1', changes: { pre_script: 'nosuchvar == 1' } });
    ok('unknown variable reported', r.data.jexl_check.errors.some(e => /Unknown variable "nosuchvar"/.test(e.message)), r.text);
    r = await call(c, 'update_question', { surveyId: C, question: 'zz_q1', changes: { pre_script: null } });
    ok('script cleared with null', (await getAsync('SELECT pre_script FROM questions WHERE id = ?', [q1.id])).pre_script === null);
    r = await call(c, 'update_question', { surveyId: C, question: q1.id, changes: { min_selections: 3, max_selections: 2 } });
    ok('min > max refused', r.isError && /min_selections/.test(r.text), r.text);
    r = await call(c, 'update_question', { surveyId: C, question: 'no_such_q', changes: { pre_script: null } });
    ok('unknown question is a clear error', r.isError && /not found/.test(r.text), r.text);

    // set_options keeps audio with the option position
    r = await call(c, 'set_audio', { surveyId: C, target: 'option', question: 'zz_q1', option_index: 0, language: lang, mp3_base64: MP3 });
    ok('set_audio on an option', !r.isError && r.data.bytes > 0, r.text);
    r = await call(c, 'set_options', { surveyId: C, question: 'zz_q1', options: [{ text: txt('Definitely') }, { text: txt('No') }, { text: txt('Unsure') }, { text: txt('Other'), is_other: true }] });
    ok('set_options succeeds', !r.isError && r.data.option_count === 4, r.text);
    const opt0 = await getAsync('SELECT * FROM options WHERE question_id = ? AND option_index = 0', [q1.id]);
    ok('option audio stays with its position', JSON.parse(opt0.audio_files_json)[lang]?.startsWith('data:audio/mp3;base64,') && JSON.parse(opt0.option_text_json)[lang] === 'Definitely');
    ok('other option moved to position 3', (await getAsync('SELECT option_index FROM options WHERE question_id = ? AND is_other = 1', [q1.id])).option_index === 3);

    const n = (await getAsync('SELECT COUNT(*) n FROM questions WHERE survey_id = ?', [C])).n;
    r = await call(c, 'move_question', { surveyId: C, question: 'zz_q1', position: 999 });
    ok('move_question to the end', !r.isError && (await getAsync('SELECT question_index FROM questions WHERE id = ?', [q1.id])).question_index === n - 1, r.text);
    const elig = await getAsync("SELECT id FROM sections WHERE survey_id = ? AND section_type = 'eligibility'", [C]);
    r = await call(c, 'move_question', { surveyId: C, question: 'zz_q1', position: 0, section_id: elig.id });
    ok('move_question into the eligibility section', (await getAsync('SELECT section_id, question_index FROM questions WHERE id = ?', [q1.id])).section_id === elig.id);
    const otherSurveySection = await getAsync("SELECT id FROM sections WHERE survey_id = ? LIMIT 1", [A]);
    r = await call(c, 'move_question', { surveyId: C, question: 'zz_q1', position: 0, section_id: otherSurveySection.id });
    ok('section from another survey refused', r.isError && /does not belong/.test(r.text), r.text);

    r = await call(c, 'delete_question', { surveyId: C, question: 'zz_q1' });
    ok('delete_question', !r.isError && r.data.deleted.short_name === 'zz_q1', r.text);
    const idx = (await allAsync('SELECT question_index FROM questions WHERE survey_id = ? ORDER BY question_index', [C])).map(x => x.question_index);
    ok('positions renumbered 0..n-1 after delete', idx.every((v, i) => v === i), idx.join(','));
    ok('options deleted with the question', (await getAsync('SELECT COUNT(*) n FROM options WHERE question_id = ?', [q1.id])).n === 0);

    section('Settings, sections, messages');
    r = await call(c, 'update_survey_settings', { surveyId: C, settings: { description: 'Edited by MCP', eligibility_script: 'zz_missing == 1' } });
    ok('settings saved, bad eligibility script reported', !r.isError && r.data.jexl_check.errors.length > 0, r.text);
    ok('settings stored', (await getAsync('SELECT description FROM surveys WHERE id = ?', [C])).description === 'Edited by MCP');
    await call(c, 'update_survey_settings', { surveyId: C, settings: { eligibility_script: aRow.eligibility_script } });
    r = await call(c, 'update_survey_settings', { surveyId: C, settings: { languages: [] } });
    ok('empty languages refused', r.isError && /languages/.test(r.text), r.text);
    const tc = await getAsync('SELECT * FROM test_configurations WHERE survey_id = ? LIMIT 1', [C]);
    if (tc) {
        r = await call(c, 'update_survey_settings', { surveyId: C, rapid_tests: [{ test_id: tc.test_id, enabled: !tc.enabled }] });
        ok('rapid test toggled', !r.isError && (await getAsync('SELECT enabled FROM test_configurations WHERE id = ?', [tc.id])).enabled === (tc.enabled ? 0 : 1), r.text);
    }
    r = await call(c, 'update_survey_settings', { surveyId: C, rapid_tests: [{ test_id: 'zz_not_a_test', enabled: true }] });
    ok('unknown rapid test refused', r.isError && /not configured/.test(r.text), r.text);
    const main = await getAsync("SELECT id FROM sections WHERE survey_id = ? AND section_type = 'main'", [C]);
    r = await call(c, 'update_section', { surveyId: C, sectionId: main.id, name: 'Main questions' });
    ok('update_section', !r.isError && (await getAsync('SELECT name FROM sections WHERE id = ?', [main.id])).name === 'Main questions', r.text);
    r = await call(c, 'set_message', { surveyId: C, message_key: 'other_specify_prompt', text: txt('Please tell us') });
    ok('set_message creates a standard message', !r.isError && !r.data.warning, r.text);
    r = await call(c, 'set_audio', { surveyId: C, target: 'message', message_key: 'other_specify_prompt', language: lang, mp3_base64: 'data:audio/mp3;base64,' + MP3 });
    ok('set_audio on a message (data URL accepted)', !r.isError, r.text);
    r = await call(c, 'set_message', { surveyId: C, message_key: 'other_specify_prompt', text: txt('Please say more') });
    const msg = await getAsync("SELECT * FROM survey_messages WHERE survey_id = ? AND message_key = 'other_specify_prompt'", [C]);
    ok('set_message keeps existing audio', JSON.parse(msg.audio_files_json)[lang] && JSON.parse(msg.message_text_json)[lang] === 'Please say more');
    r = await call(c, 'set_message', { surveyId: C, message_key: 'zz_custom', text: txt('x') });
    ok('non-standard message key warns', !r.isError && /not a standard message key/.test(r.data.warning || ''), r.text);

    section('Audio validation');
    const q0 = await getAsync('SELECT * FROM questions WHERE survey_id = ? ORDER BY question_index LIMIT 1', [C]);
    r = await call(c, 'set_audio', { surveyId: C, target: 'question', question: q0.id, language: lang, mp3_base64: PNG });
    ok('non-MP3 refused', r.isError && /not an MP3/.test(r.text), r.text);
    r = await call(c, 'set_audio', { surveyId: C, target: 'question', question: q0.id, language: 'Klingon', mp3_base64: MP3 });
    ok('unknown language refused', r.isError && /not one of this survey's languages/.test(r.text), r.text);
    r = await call(c, 'set_audio', { surveyId: C, target: 'question', question: q0.id, language: lang, mp3_base64: 'not base64!!' });
    ok('invalid base64 refused', r.isError && /base64/.test(r.text), r.text);
    const big = Buffer.concat([Buffer.from([0xFF, 0xFB, 0x90, 0x64]), Buffer.alloc(10 * 1024 * 1024 + 10)]).toString('base64');
    r = await call(c, 'set_audio', { surveyId: C, target: 'question', question: q0.id, language: lang, mp3_base64: big });
    ok('over 10 MB refused', r.isError && /limit is 10 MB/.test(r.text), r.text);
    r = await call(c, 'set_audio', { surveyId: C, target: 'question', question: q0.id, language: lang, mp3_base64: MP3 });
    ok('valid MP3 stored, survey total reported', !r.isError && typeof r.data.survey_audio_total_mb === 'number', r.text);
    r = await call(c, 'remove_audio', { surveyId: C, target: 'question', question: q0.id, language: lang });
    ok('remove_audio', !r.isError && r.data.removed && !JSON.parse((await getAsync('SELECT audio_files_json a FROM questions WHERE id = ?', [q0.id])).a)[lang], r.text);

    section('replace_survey and create_survey');
    const getC = await call(c, 'get_survey', { surveyId: C });
    r = await call(c, 'replace_survey', { surveyId: C, bundle: getC.data, expected_updated_at: '2000-01-01 00:00:00' });
    ok('stale expected_updated_at refused', r.isError && /changed since it was read/.test(r.text), r.text);
    const bundle = JSON.parse(JSON.stringify(getC.data));
    bundle.survey.description = 'Replaced';
    bundle.questions = bundle.questions.slice(0, 3);
    r = await call(c, 'replace_survey', { surveyId: C, bundle, expected_updated_at: getC.data.survey.updated_at });
    ok('replace_survey with the current updated_at', !r.isError && r.data.counts.questions === 3, r.text);
    ok('replace kept id, status and lineage', (await getAsync('SELECT * FROM surveys WHERE id = ?', [C])).parent_survey_id === A &&
        (await getAsync('SELECT COUNT(*) n FROM questions WHERE survey_id = ?', [C])).n === 3 &&
        (await getAsync('SELECT description FROM surveys WHERE id = ?', [C])).description === 'Replaced');
    r = await call(c, 'replace_survey', { surveyId: C, bundle, expected_updated_at: getC.data.survey.updated_at });
    ok('second replace with the old updated_at refused', r.isError, r.text);
    const noMain = JSON.parse(JSON.stringify(bundle));
    noMain.sections = noMain.sections.filter(s => s.section_type !== 'main');
    r = await call(c, 'create_survey', { bundle: noMain });
    ok('create_survey without a main section refused', r.isError && /"main"/.test(r.text), r.text);
    const extraSec = JSON.parse(JSON.stringify(bundle));
    extraSec.sections.push({ id: 9999, section_index: 2, section_type: 'conclusion', name: 'End' });
    r = await call(c, 'create_survey', { bundle: extraSec });
    ok('create_survey with a third section type refused', r.isError && /only be eligibility and main/.test(r.text), r.text);
    const twoElig = JSON.parse(JSON.stringify(bundle));
    twoElig.sections.push({ ...twoElig.sections.find(x => x.section_type === 'eligibility'), id: 9998 });
    r = await call(c, 'create_survey', { bundle: twoElig });
    ok('create_survey with two eligibility sections refused', r.isError && /2 "eligibility" sections/.test(r.text), r.text);
    const fresh = JSON.parse(JSON.stringify(bundle));
    fresh.survey.name = 'ZZ MCP created';
    fresh.questions.forEach(q => { q.question_text_json = JSON.parse(q.question_text_json); });
    r = await call(c, 'create_survey', { bundle: fresh });
    ok('create_survey (text as objects)', !r.isError && r.data.surveyId && r.data.check, r.text);
    const created = await getAsync('SELECT * FROM surveys WHERE id = ?', [r.data.surveyId]);
    ok('created survey is an inactive draft', created.is_active === 0 && created.is_draft === 1 && created.base_survey_id === created.id);
    const dupBundle = JSON.parse(JSON.stringify(bundle));
    dupBundle.questions[1].short_name = dupBundle.questions[0].short_name;
    r = await call(c, 'create_survey', { bundle: dupBundle });
    ok('bundle with duplicate short names refused', r.isError && /unique/.test(r.text), r.text);

    section('Lab tests');
    const code = 'ZZ' + Date.now().toString().slice(-6);
    r = await call(c, 'create_lab_test', { test_name: 'ZZ MCP test ' + code, test_code: code, test_type: 'dropdown', options: ['Positive', 'Negative'], jexl_condition: 'nosuch == 1' });
    ok('create_lab_test', !r.isError && r.data.labTestId && /every facility/.test(r.data.notes[0]), r.text);
    ok('lab condition checked', r.data.jexl_check && (r.data.jexl_check.errors.length + r.data.jexl_check.warnings.length) > 0, r.text);
    const L = r.data.labTestId;
    r = await call(c, 'create_lab_test', { test_name: 'ZZ MCP test ' + code, test_type: 'numeric' });
    ok('duplicate lab test name refused', r.isError && /already exists/.test(r.text), r.text);
    r = await call(c, 'update_lab_test', { labTestId: L, options: ['Positive', 'Negative', 'Indeterminate'] });
    ok('add an option (no results yet)', !r.isError, r.text);
    await runAsync('INSERT INTO lab_results (subject_id, test_id, result_value, submitted_by) VALUES (?, ?, ?, ?)', ['ZZSUBJ', L, 'Positive', admin.id]);
    r = await call(c, 'update_lab_test', { labTestId: L, test_code: code + 'X' });
    ok('code change refused once results exist', r.isError && /already has 1 result/.test(r.text) && /test_code/.test(r.text), r.text);
    r = await call(c, 'update_lab_test', { labTestId: L, test_type: 'numeric' });
    ok('type change refused once results exist', r.isError && /test_type/.test(r.text), r.text);
    r = await call(c, 'update_lab_test', { labTestId: L, options: ['Positive', 'Negative'] });
    ok('removing an option refused once results exist', r.isError && /Indeterminate/.test(r.text), r.text);
    r = await call(c, 'update_lab_test', { labTestId: L, test_name: 'ZZ MCP renamed ' + code, description: 'd', jexl_condition: null });
    ok('rename / description / condition still editable', !r.isError && (await getAsync('SELECT test_name FROM lab_test_configurations WHERE id = ?', [L])).test_name === 'ZZ MCP renamed ' + code, r.text);
    const listL = await call(c, 'list_lab_tests');
    ok('list_lab_tests shows result counts', listL.data.find(x => x.id === L)?.result_count === 1);
    r = await call(c, 'deactivate_lab_test', { labTestId: L });
    ok('deactivate_lab_test', !r.isError && (await getAsync('SELECT is_active FROM lab_test_configurations WHERE id = ?', [L])).is_active === 0, r.text);
    r = await call(c, 'reactivate_lab_test', { labTestId: L });
    ok('reactivate_lab_test says it reaches every facility', !r.isError && /every facility/.test(r.data.notes[0]), r.text);
    r = await call(c, 'get_lab_test', { labTestId: L });
    ok('get_lab_test', !r.isError && r.data.result_count === 1 && Array.isArray(r.data.options));

    section('Audit trail');
    const audits = await allAsync("SELECT action, entity_type, new_value FROM audit_log WHERE timestamp >= ? AND new_value LIKE '%\"via\":\"mcp\"%'", [startedAt]);
    const actions = new Set(audits.map(a => a.action));
    for (const a of ['COPY_SURVEY', 'ADD_QUESTION', 'UPDATE_QUESTION', 'MOVE_QUESTION', 'DELETE_QUESTION', 'UPDATE_SURVEY', 'UPDATE_SECTION',
        'UPDATE_MESSAGE', 'SET_AUDIO', 'REMOVE_AUDIO', 'REPLACE_SURVEY', 'IMPORT_SURVEY', 'CREATE_LAB_TEST', 'UPDATE_LAB_TEST',
        'DEACTIVATE_LAB_TEST', 'REACTIVATE_LAB_TEST']) {
        ok(`audit entry ${a} with via: mcp`, actions.has(a), [...actions].join(','));
    }
    ok('refused writes leave no audit entry for the active survey',
        !(await allAsync("SELECT 1 FROM audit_log WHERE timestamp >= ? AND entity_type = 'survey' AND entity_id = ? AND action = 'UPDATE_SURVEY'", [startedAt, String(A)])).length);

    await c.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
