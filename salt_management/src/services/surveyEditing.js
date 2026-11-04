/**
 * surveyEditing.js — survey edits shared by the web survey editor routes
 * (src/api/routes/surveyConfigSimple.js, surveyMessages.js) and the MCP survey
 * tools (src/mcp/surveyTools.js), so both apply the same rules.
 *
 * Every write:
 *   - checks the rules (reserved and duplicate short names, "other" options,
 *     multi-select bounds, sections belonging to the survey, ...);
 *   - refuses an active survey when ctx.requireInactive is set (MCP);
 *   - bumps surveys.updated_at, so expected_updated_at guards and the tablet
 *     survey checksum both see the change;
 *   - writes an audit entry (with ctx.via, e.g. 'mcp').
 *
 * Failures throw EditError with an HTTP-style status (400/404/409) and a
 * message meant for the person or AI that made the request.
 *
 * ctx: { userId, via?: 'web'|'mcp', requireInactive?: boolean }
 */

const { getAsync, allAsync, runAsync } = require('../models/database');
const database = require('../models/database');
const { logAudit } = require('./auditService');
const { isOtherFlag, validateOtherOptions, otherNameClash } = require('./otherOption');
const { importSurveyBundle, replaceSurveyContents } = require('./surveyImport');
const { buildSurveyBundle } = require('./surveyBundle');
const { checkSurvey, filterIssues } = require('./jexlCheck');

class EditError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const QUESTION_TYPES = ['multiple_choice', 'numeric', 'text', 'multi_select', 'info'];
const SHORT_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const RESERVED_NAMES = {
    // The JEXL variable bound to the current answer in validation and skip-to scripts.
    value: '"value" is a reserved name and cannot be used as a short name',
    // The facility's coupon ceiling, bound in the coupon_count_script context.
    facility_coupons: '"facility_coupons" is a reserved name and cannot be used as a short name'
};

// The standard system message keys (the list in surveyEditorSimple.ejs is the
// authoritative source; keep in step). Rapid tests add <testId>_rapid_test_instruction.
const STANDARD_MESSAGE_KEYS = [
    'eligibility_not_eligible', 'staff_validation', 'payment_confirmation',
    'consent_agreement', 'coupon_instructions', 'other_specify_prompt'
];

// Survey settings a targeted edit may change, with how each is stored.
const SETTINGS = {
    name: 'text', description: 'text', languages: 'json', eligibility_script: 'text',
    coupon_count_script: 'text', eligibility_message_json: 'json',
    staff_validation_message_json: 'json', fingerprint_enabled: 'flag',
    re_enrollment_days: 'int', contact_info_enabled: 'flag', staff_eligibility_screening: 'flag',
    rapid_test_samples_after_eligibility: 'flag', payment_audit_phone_enabled: 'flag',
    hiv_rapid_test_enabled: 'flag'
};

const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // decoded MP3 size cap per file

// ---------------------------------------------------------------------------
// Helpers

function parseJson(text, fallback) {
    if (text && typeof text === 'object') return text;
    try { return JSON.parse(text || ''); } catch { return fallback; }
}

function surveyLanguages(survey) {
    const langs = parseJson(survey.languages, []);
    return Array.isArray(langs) ? langs : [];
}

async function loadSurvey(surveyId, ctx = {}) {
    const survey = await getAsync('SELECT * FROM surveys WHERE id = ?', [surveyId]);
    if (!survey) throw new EditError(404, `Survey ${surveyId} not found`);
    if (ctx.requireInactive && survey.is_active) {
        throw new EditError(409,
            `Survey ${surveyId} ("${survey.name}" v${survey.version}) is active, so tablets download it at their next login. ` +
            'It can\'t be edited here. Use copy_survey to make an inactive copy, edit that, and ask an administrator ' +
            'to review and activate it in the web app.');
    }
    return survey;
}

async function loadQuestion(surveyId, questionRef) {
    const byName = typeof questionRef === 'string' && !/^\d+$/.test(questionRef);
    const question = byName
        ? await getAsync('SELECT * FROM questions WHERE survey_id = ? AND short_name = ?', [surveyId, questionRef])
        : await getAsync('SELECT * FROM questions WHERE survey_id = ? AND id = ?', [surveyId, Number(questionRef)]);
    if (!question) throw new EditError(404, `Question ${JSON.stringify(questionRef)} not found in survey ${surveyId}`);
    return question;
}

// Millisecond precision, so two edits within one second still change
// updated_at and the expected_updated_at guard notices the second.
const NOW_MS = "strftime('%Y-%m-%d %H:%M:%f', 'now')";

async function touch(surveyId) {
    await runAsync(`UPDATE surveys SET updated_at = ${NOW_MS} WHERE id = ?`, [surveyId]);
}

function audit(ctx, action, entityType, entityId, oldValue, newValue) {
    let withVia = newValue;
    if (ctx.via) withVia = newValue && typeof newValue === 'object' ? { ...newValue, via: ctx.via } : { via: ctx.via };
    return logAudit(ctx.userId || null, action, entityType, String(entityId), oldValue, withVia)
        .catch(err => console.error('Audit write failed:', err));
}

/**
 * JEXL check results to return with a save. Saves are never blocked by the
 * check (drafts are often half-finished), and a checker failure never fails
 * the save. `scope` is passed to filterIssues.
 */
async function jexlReport(surveyId, scope) {
    try {
        const full = await checkSurvey(database, surveyId);
        if (!full) return null;
        return {
            ...filterIssues(full, scope),
            survey_error_count: full.errors.length,
            survey_warning_count: full.warnings.length
        };
    } catch (err) {
        console.error('JEXL check failed:', err);
        return null;
    }
}

function checkShortName(shortName) {
    if (typeof shortName !== 'string' || !SHORT_NAME_RE.test(shortName)) {
        throw new EditError(400, 'Short name must start with a letter or underscore, and contain only letters, numbers, and underscores');
    }
    if (RESERVED_NAMES[shortName]) throw new EditError(400, RESERVED_NAMES[shortName]);
}

// The survey's questions other than `excludeId`, with whether each has an
// "other" option — for the reserved <short_name>_other name check.
async function siblingQuestions(surveyId, excludeId) {
    const rows = await allAsync(
        `SELECT q.short_name,
                EXISTS(SELECT 1 FROM options o WHERE o.question_id = q.id AND o.is_other = 1) AS has_other
         FROM questions q WHERE q.survey_id = ? AND q.id != ?`,
        [surveyId, excludeId || 0]
    );
    return rows.map(r => ({ short_name: r.short_name, has_other: !!r.has_other }));
}

async function checkQuestionRules(surveyId, excludeId, { shortName, type, options, minSel, maxSel, sectionId, skipToTarget }) {
    checkShortName(shortName);
    if (!QUESTION_TYPES.includes(type)) {
        throw new EditError(400, `question_type must be one of ${QUESTION_TYPES.join(', ')}`);
    }
    const siblings = await siblingQuestions(surveyId, excludeId);
    if (siblings.some(q => q.short_name === shortName)) {
        throw new EditError(409, `Another question in this survey already uses the short name "${shortName}"`);
    }
    const otherError = validateOtherOptions(type, options)
        || otherNameClash({ short_name: shortName, has_other: options.some(o => isOtherFlag(o.is_other)) }, siblings);
    if (otherError) throw new EditError(400, otherError);
    for (const [label, v] of [['min_selections', minSel], ['max_selections', maxSel]]) {
        if (v != null && (!Number.isInteger(Number(v)) || Number(v) < 1)) {
            throw new EditError(400, `${label} must be a whole number of at least 1`);
        }
    }
    if (minSel != null && maxSel != null && Number(minSel) > Number(maxSel)) {
        throw new EditError(400, 'min_selections cannot be more than max_selections');
    }
    if (sectionId != null) {
        const section = await getAsync('SELECT id FROM sections WHERE id = ? AND survey_id = ?', [sectionId, surveyId]);
        if (!section) throw new EditError(400, `Section ${sectionId} does not belong to survey ${surveyId}`);
    }
    if (skipToTarget && !/^[a-zA-Z0-9_]*$/.test(skipToTarget)) {
        throw new EditError(400, 'skip_to_target must be a question short name');
    }
}

// Options accept the web editor's shape ({option_index, text_json, audio_json,
// is_other}) and the bundle shape ({option_text_json, audio_files_json}).
function normalizeOptions(options) {
    if (options == null) return [];
    if (!Array.isArray(options)) throw new EditError(400, 'options must be an array');
    return options.map((o, i) => {
        if (!o || typeof o !== 'object') throw new EditError(400, `Option ${i} must be an object`);
        const textJson = o.text_json ?? o.option_text_json ?? o.text;
        const text = parseJson(textJson, null);
        if (!text || typeof text !== 'object') {
            throw new EditError(400, `Option ${i} needs its text as an object of language → text`);
        }
        return {
            option_index: o.option_index != null ? Number(o.option_index) : i,
            text,
            audio: o.audio_json ?? o.audio_files_json,
            is_other: isOtherFlag(o.is_other) ? 1 : 0
        };
    });
}

async function insertOptions(questionId, options, keepAudioFrom = null) {
    for (const o of options) {
        let audio = parseJson(o.audio, null);
        if (!audio && keepAudioFrom) audio = keepAudioFrom.get(o.option_index) || null;
        await runAsync(
            `INSERT INTO options (question_id, option_index, option_text_json, audio_files_json, is_other)
             VALUES (?, ?, ?, ?, ?)`,
            [questionId, o.option_index || 0, JSON.stringify(o.text), JSON.stringify(audio || {}), o.is_other]
        );
    }
}

async function shiftQuestions(surveyId, fromIndex, delta) {
    await runAsync(
        'UPDATE questions SET question_index = question_index + ? WHERE survey_id = ? AND question_index >= ?',
        [delta, surveyId, fromIndex]
    );
}

async function renumberQuestions(surveyId, orderedIds) {
    for (let i = 0; i < orderedIds.length; i++) {
        await runAsync('UPDATE questions SET question_index = ? WHERE id = ? AND survey_id = ?', [i, orderedIds[i], surveyId]);
    }
}

// ---------------------------------------------------------------------------
// Questions

/**
 * fields: short_name, question_type, question_text_json, audio_files_json,
 * validation_script, validation_error_json, pre_script, section_id, options,
 * min_selections, max_selections, skip_to_script, skip_to_target, and either
 * question_index (stored as given, as the web editor does) or position
 * (0-based; later questions move down; default: at the end).
 */
async function addQuestion(surveyId, fields, ctx = {}) {
    await loadSurvey(surveyId, ctx);
    const options = normalizeOptions(fields.options);
    const textJson = parseJson(fields.question_text_json, null);
    if (!textJson || typeof textJson !== 'object') {
        throw new EditError(400, 'question_text_json must be an object of language → text');
    }
    await checkQuestionRules(surveyId, null, {
        shortName: fields.short_name, type: fields.question_type, options,
        minSel: fields.min_selections || null, maxSel: fields.max_selections || null,
        sectionId: fields.section_id || null, skipToTarget: fields.skip_to_target
    });

    // If no section_id provided, default to the survey's "main" section
    // (falling back to the lowest-index section). The non-eligibility body
    // section is 'main' — there is no 'survey' section_type.
    let sectionId = fields.section_id || null;
    if (!sectionId) {
        const defaultSection = await getAsync(
            `SELECT id FROM sections WHERE survey_id = ?
             ORDER BY (section_type = 'main') DESC, section_index ASC LIMIT 1`,
            [surveyId]
        );
        sectionId = defaultSection ? defaultSection.id : null;
    }

    let questionIndex = fields.question_index;
    if (questionIndex === undefined || questionIndex === null) {
        const count = (await getAsync('SELECT COUNT(*) n FROM questions WHERE survey_id = ?', [surveyId])).n;
        const position = fields.position == null ? count : Math.max(0, Math.min(Number(fields.position), count));
        await shiftQuestions(surveyId, position, 1);
        questionIndex = position;
    }

    const result = await runAsync(
        `INSERT INTO questions (survey_id, question_index, short_name, question_text_json,
         audio_files_json, question_type, validation_script, validation_error_json, pre_script, section_id,
         min_selections, max_selections, skip_to_script, skip_to_target)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [surveyId, questionIndex, fields.short_name, JSON.stringify(textJson),
         JSON.stringify(parseJson(fields.audio_files_json, null) || {}), fields.question_type,
         fields.validation_script || null,
         JSON.stringify(parseJson(fields.validation_error_json, null) || { English: 'Invalid answer' }),
         fields.pre_script || null, sectionId,
         fields.min_selections || null, fields.max_selections || null,
         fields.skip_to_script || null, fields.skip_to_target || null]
    );
    const questionId = result.id;
    await insertOptions(questionId, options);
    await touch(surveyId);
    await audit(ctx, 'ADD_QUESTION', 'question', questionId, null,
        { surveyId, short_name: fields.short_name, question_text_json: textJson });
    return { id: questionId, question_index: questionIndex };
}

const QUESTION_COLUMNS = {
    question_index: 'raw', short_name: 'raw', question_text_json: 'json', audio_files_json: 'json',
    question_type: 'raw', validation_script: 'raw', validation_error_json: 'json', pre_script: 'raw',
    section_id: 'raw', min_selections: 'raw', max_selections: 'raw', skip_to_script: 'raw', skip_to_target: 'raw'
};

/**
 * Updates the given fields; fields left out keep their values. `options`
 * replaces all options. With keepOptionAudio, an option sent without audio
 * keeps the audio previously stored at the same position.
 */
async function updateQuestion(surveyId, questionRef, fields, ctx = {}, { keepOptionAudio = false } = {}) {
    await loadSurvey(surveyId, ctx);
    const question = await loadQuestion(surveyId, questionRef);
    const questionId = question.id;
    const options = fields.options !== undefined ? normalizeOptions(fields.options) : null;
    const currentOptions = await allAsync('SELECT * FROM options WHERE question_id = ? ORDER BY option_index', [questionId]);

    const pick = (k) => (fields[k] !== undefined ? fields[k] : question[k]);
    await checkQuestionRules(surveyId, questionId, {
        shortName: pick('short_name'), type: pick('question_type') || question.question_type,
        options: options || currentOptions, minSel: pick('min_selections'), maxSel: pick('max_selections'),
        sectionId: fields.section_id !== undefined ? fields.section_id : null,
        skipToTarget: fields.skip_to_target
    });
    if (fields.question_text_json !== undefined) {
        const t = parseJson(fields.question_text_json, null);
        if (!t || typeof t !== 'object') throw new EditError(400, 'question_text_json must be an object of language → text');
    }

    const updates = [];
    const params = [];
    for (const [col, kind] of Object.entries(QUESTION_COLUMNS)) {
        if (fields[col] === undefined) continue;
        updates.push(`${col} = ?`);
        params.push(kind === 'json' ? JSON.stringify(parseJson(fields[col], {})) : fields[col]);
    }
    if (updates.length > 0) {
        params.push(questionId);
        await runAsync(`UPDATE questions SET ${updates.join(', ')} WHERE id = ?`, params);
    }
    if (options) {
        const keep = keepOptionAudio
            ? new Map(currentOptions.map(o => [o.option_index, parseJson(o.audio_files_json, {})]))
            : null;
        await runAsync('DELETE FROM options WHERE question_id = ?', [questionId]);
        await insertOptions(questionId, options, keep);
    }
    await touch(surveyId);
    await audit(ctx, 'UPDATE_QUESTION', 'question', questionId,
        { ...question, options: options ? currentOptions : undefined }, fields);
    return { id: questionId };
}

async function deleteQuestion(surveyId, questionRef, ctx = {}) {
    await loadSurvey(surveyId, ctx);
    const question = await loadQuestion(surveyId, questionRef);
    await runAsync('DELETE FROM options WHERE question_id = ?', [question.id]);
    await runAsync('DELETE FROM questions WHERE id = ?', [question.id]);
    if (ctx.via === 'mcp') {
        // Close the gap so positions stay 0..n-1 (the web editor renumbers on reorder).
        const ids = (await allAsync('SELECT id FROM questions WHERE survey_id = ? ORDER BY question_index, id', [surveyId])).map(r => r.id);
        await renumberQuestions(surveyId, ids);
    }
    await touch(surveyId);
    await audit(ctx, 'DELETE_QUESTION', 'question', question.id, question, null);
    return { id: question.id, short_name: question.short_name };
}

/** Sets question_index from an ordered list of question ids (the web editor's drag-and-drop). */
async function reorderQuestions(surveyId, questionOrder, ctx = {}) {
    await loadSurvey(surveyId, ctx);
    await renumberQuestions(surveyId, questionOrder);
    await touch(surveyId);
    await audit(ctx, 'REORDER_QUESTIONS', 'survey', surveyId, null, { questionOrder });
}

/** Moves one question to a 0-based position (and optionally into another section). */
async function moveQuestion(surveyId, questionRef, position, ctx = {}, { sectionId } = {}) {
    await loadSurvey(surveyId, ctx);
    const question = await loadQuestion(surveyId, questionRef);
    const ids = (await allAsync('SELECT id FROM questions WHERE survey_id = ? ORDER BY question_index, id', [surveyId]))
        .map(r => r.id).filter(id => id !== question.id);
    const pos = Math.max(0, Math.min(Number(position), ids.length));
    ids.splice(pos, 0, question.id);
    await renumberQuestions(surveyId, ids);
    if (sectionId !== undefined && sectionId !== null) {
        const section = await getAsync('SELECT id FROM sections WHERE id = ? AND survey_id = ?', [sectionId, surveyId]);
        if (!section) throw new EditError(400, `Section ${sectionId} does not belong to survey ${surveyId}`);
        await runAsync('UPDATE questions SET section_id = ? WHERE id = ?', [sectionId, question.id]);
    }
    await touch(surveyId);
    await audit(ctx, 'MOVE_QUESTION', 'question', question.id,
        { question_index: question.question_index, section_id: question.section_id },
        { question_index: pos, section_id: sectionId ?? question.section_id });
    return { id: question.id, position: pos };
}

// ---------------------------------------------------------------------------
// Survey settings, sections, rapid tests

/**
 * fields: any of SETTINGS. rapidTests: [{test_id, enabled?, display_order?}]
 * updates this survey's existing test_configurations rows.
 */
async function updateSurveySettings(surveyId, fields, ctx = {}, { rapidTests } = {}) {
    const survey = await loadSurvey(surveyId, ctx);
    const updates = [];
    const params = [];
    for (const [col, kind] of Object.entries(SETTINGS)) {
        if (fields[col] === undefined) continue;
        let v = fields[col];
        if (kind === 'json') v = v === null ? null : (typeof v === 'object' ? JSON.stringify(v) : v);
        if (kind === 'flag') v = v ? 1 : 0;
        if (kind === 'int') {
            v = Number(v);
            if (!Number.isInteger(v) || v < 1 || v > 365) throw new EditError(400, `${col} must be a whole number from 1 to 365`);
        }
        if (col === 'name' && !String(v || '').trim()) throw new EditError(400, 'name cannot be empty');
        if (col === 'languages') {
            const langs = parseJson(v, null);
            if (!Array.isArray(langs) || !langs.length || langs.some(l => typeof l !== 'string' || !l.trim())) {
                throw new EditError(400, 'languages must be a non-empty list of language names, e.g. ["English", "French"]');
            }
        }
        updates.push(`${col} = ?`);
        params.push(v);
    }
    const testChanges = [];
    for (const t of rapidTests || []) {
        const row = await getAsync('SELECT * FROM test_configurations WHERE survey_id = ? AND test_id = ?', [surveyId, t.test_id]);
        if (!row) throw new EditError(404, `Rapid test "${t.test_id}" is not configured for survey ${surveyId}`);
        testChanges.push({ row, t });
    }
    if (updates.length > 0) {
        updates.push(`updated_at = ${NOW_MS}`);
        params.push(surveyId);
        await runAsync(`UPDATE surveys SET ${updates.join(', ')} WHERE id = ?`, params);
    }
    for (const { row, t } of testChanges) {
        await runAsync(
            'UPDATE test_configurations SET enabled = ?, display_order = ? WHERE id = ?',
            [t.enabled === undefined ? row.enabled : (t.enabled ? 1 : 0),
             t.display_order === undefined ? row.display_order : Number(t.display_order), row.id]
        );
    }
    if (testChanges.length) await touch(surveyId);
    await audit(ctx, 'UPDATE_SURVEY', 'survey', surveyId, survey,
        { ...fields, ...(testChanges.length ? { rapid_tests: rapidTests } : {}) });
}

async function updateSection(surveyId, sectionId, { name, description }, ctx = {}) {
    await loadSurvey(surveyId, ctx);
    const section = await getAsync('SELECT * FROM sections WHERE id = ? AND survey_id = ?', [sectionId, surveyId]);
    if (!section) throw new EditError(404, `Section ${sectionId} not found in survey ${surveyId}`);
    if (name !== undefined && !String(name).trim()) throw new EditError(400, 'name cannot be empty');
    await runAsync('UPDATE sections SET name = ?, description = ? WHERE id = ?',
        [name !== undefined ? name : section.name, description !== undefined ? description : section.description, sectionId]);
    await touch(surveyId);
    await audit(ctx, 'UPDATE_SECTION', 'section', sectionId, section, { name, description });
}

// ---------------------------------------------------------------------------
// System messages

/**
 * Creates or updates a message. audio: undefined keeps the stored audio
 * (MCP) or, with replaceAudio, stores `audio || {}` (the web editor sends the
 * full audio map on every save).
 */
async function setMessage(surveyId, messageKey, { text, audio, messageType, displayOrder }, ctx = {}, { replaceAudio = false } = {}) {
    await loadSurvey(surveyId, ctx);
    if (!text || typeof text !== 'object') {
        throw new EditError(400, 'message_text_json is required and must be an object');
    }
    // Keys are identifiers, but rapid test ids (and so <testId>_rapid_test_instruction)
    // may be in any script, e.g. Armenian.
    if (!messageKey || !/^[^\s/]+$/u.test(messageKey)) {
        throw new EditError(400, 'message_key cannot be empty or contain spaces or slashes');
    }
    const existing = await getAsync('SELECT * FROM survey_messages WHERE survey_id = ? AND message_key = ?', [surveyId, messageKey]);
    const audioJson = replaceAudio || !existing
        ? JSON.stringify(audio || {})
        : (audio !== undefined ? JSON.stringify(audio || {}) : existing.audio_files_json || '{}');
    const type = messageType || (existing && existing.message_type) || 'system';
    const order = displayOrder ?? (existing && existing.display_order) ?? 0;
    await runAsync(
        `INSERT INTO survey_messages (survey_id, message_key, message_text_json, audio_files_json, message_type, display_order, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(survey_id, message_key) DO UPDATE SET
            message_text_json = excluded.message_text_json,
            audio_files_json = excluded.audio_files_json,
            message_type = excluded.message_type,
            display_order = excluded.display_order,
            updated_at = CURRENT_TIMESTAMP`,
        [surveyId, messageKey, JSON.stringify(text), audioJson, type, order]
    );
    await touch(surveyId);
    await audit(ctx, 'UPDATE_MESSAGE', 'survey_message', `${surveyId}:${messageKey}`,
        existing ? { message_text_json: existing.message_text_json } : null,
        { surveyId, messageKey, message_type: type, message_text_json: text });
    return getAsync('SELECT * FROM survey_messages WHERE survey_id = ? AND message_key = ?', [surveyId, messageKey]);
}

async function isKnownMessageKey(surveyId, key) {
    if (STANDARD_MESSAGE_KEYS.includes(key)) return true;
    const m = /^(.+)_rapid_test_instruction$/.exec(key);
    if (!m) return false;
    return !!(await getAsync('SELECT 1 FROM test_configurations WHERE survey_id = ? AND test_id = ?', [surveyId, m[1]]));
}

// ---------------------------------------------------------------------------
// Audio

/** Decodes and checks an MP3 upload; returns the data URL stored in audio_files_json. */
function decodeMp3(mp3Base64) {
    if (typeof mp3Base64 !== 'string' || !mp3Base64.trim()) throw new EditError(400, 'mp3_base64 is required');
    const raw = mp3Base64.trim().replace(/^data:audio\/(mp3|mpeg);base64,/i, '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new EditError(400, 'mp3_base64 is not valid base64');
    const bytes = Buffer.from(raw, 'base64');
    if (bytes.length === 0) throw new EditError(400, 'mp3_base64 decodes to an empty file');
    if (bytes.length > MAX_AUDIO_BYTES) {
        throw new EditError(400, `Audio is ${(bytes.length / 1048576).toFixed(1)} MB; the limit is 10 MB per file`);
    }
    const isId3 = bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
    const isFrame = bytes.length >= 2 && bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0;
    if (!isId3 && !isFrame) throw new EditError(400, 'The file is not an MP3 (it does not start with an ID3 tag or an MP3 frame header)');
    return { dataUrl: `data:audio/mp3;base64,${raw}`, bytes: bytes.length };
}

/** Bytes of decoded audio stored for a survey (what each tablet downloads). */
async function surveyAudioBytes(surveyId) {
    const rows = await allAsync(
        `SELECT audio_files_json a FROM questions WHERE survey_id = ?
         UNION ALL SELECT o.audio_files_json FROM options o JOIN questions q ON q.id = o.question_id WHERE q.survey_id = ?
         UNION ALL SELECT audio_files_json FROM survey_messages WHERE survey_id = ?`,
        [surveyId, surveyId, surveyId]
    );
    let total = 0;
    for (const r of rows) {
        for (const v of Object.values(parseJson(r.a, {}) || {})) {
            if (typeof v === 'string') total += Math.floor(v.replace(/^data:[^,]*,/, '').length * 3 / 4);
        }
    }
    return total;
}

/**
 * target: { type: 'question'|'option'|'message', question?, option_index?, message_key? }
 * mp3Base64: null removes the audio for that language.
 */
async function setAudio(surveyId, target, language, mp3Base64, ctx = {}) {
    const survey = await loadSurvey(surveyId, ctx);
    const languages = surveyLanguages(survey);
    if (!languages.includes(language)) {
        throw new EditError(400, `"${language}" is not one of this survey's languages (${languages.join(', ') || 'none'})`);
    }
    const audio = mp3Base64 === null ? null : decodeMp3(mp3Base64);

    let table, id, label;
    if (target.type === 'question') {
        const q = await loadQuestion(surveyId, target.question);
        table = 'questions'; id = q.id; label = `question ${q.short_name}`;
    } else if (target.type === 'option') {
        const q = await loadQuestion(surveyId, target.question);
        const o = await getAsync('SELECT id FROM options WHERE question_id = ? AND option_index = ?', [q.id, target.option_index]);
        if (!o) throw new EditError(404, `Question ${q.short_name} has no option ${target.option_index}`);
        table = 'options'; id = o.id; label = `option ${target.option_index} of ${q.short_name}`;
    } else if (target.type === 'message') {
        const m = await getAsync('SELECT id FROM survey_messages WHERE survey_id = ? AND message_key = ?', [surveyId, target.message_key]);
        if (!m) throw new EditError(404, `Message "${target.message_key}" not found; create it with set_message first`);
        table = 'survey_messages'; id = m.id; label = `message ${target.message_key}`;
    } else {
        throw new EditError(400, 'target must be question, option or message');
    }

    const row = await getAsync(`SELECT audio_files_json FROM ${table} WHERE id = ?`, [id]);
    const map = parseJson(row.audio_files_json, {}) || {};
    const had = !!map[language];
    if (audio) map[language] = audio.dataUrl; else delete map[language];
    await runAsync(`UPDATE ${table} SET audio_files_json = ? WHERE id = ?`, [JSON.stringify(map), id]);
    await touch(surveyId);
    await audit(ctx, audio ? 'SET_AUDIO' : 'REMOVE_AUDIO', table.replace(/s$/, ''), id,
        { language, had_audio: had }, { surveyId, target: label, language, bytes: audio ? audio.bytes : 0 });
    return { target: label, language, bytes: audio ? audio.bytes : 0, removed: !audio, had_audio: had };
}

// ---------------------------------------------------------------------------
// Whole surveys

const dbx = { run: runAsync, all: allAsync };


function bundleError(err) {
    if (err && err.validation) return new EditError(400, err.message);
    return err;
}

/** New inactive draft from a bundle. */
async function createSurveyFromBundle(bundle, ctx = {}) {
    let result;
    try { result = await importSurveyBundle(dbx, bundle); } catch (err) { throw bundleError(err); }
    await runAsync('UPDATE surveys SET base_survey_id = ? WHERE id = ?', [result.surveyId, result.surveyId]);
    await audit(ctx, 'IMPORT_SURVEY', 'survey', result.surveyId, null,
        { name: result.name, version: result.version, questions: result.counts.questions });
    return result;
}

/**
 * Copies a survey with everything in it (settings, sections, questions,
 * options, messages, rapid tests, audio) through the export bundle, so no
 * field is forgotten. The copy is inactive.
 *   overrides: survey settings (SETTINGS keys) to change on the copy
 *   lineage:   { baseSurveyId, parentSurveyId, version, isDraft }; a null
 *              baseSurveyId means "the copy itself" (a separate survey)
 */
async function cloneSurvey(sourceId, { overrides = {}, lineage = {} } = {}) {
    const bundle = await buildSurveyBundle(sourceId);
    if (!bundle) throw new EditError(404, `Survey ${sourceId} not found`);
    for (const [col, kind] of Object.entries(SETTINGS)) {
        if (overrides[col] === undefined) continue;
        const v = overrides[col];
        bundle.survey[col] = kind === 'json' && v !== null && typeof v === 'object' ? JSON.stringify(v)
            : kind === 'flag' ? (v ? 1 : 0) : v;
    }
    let result;
    try { result = await importSurveyBundle(dbx, bundle); } catch (err) { throw bundleError(err); }
    const id = result.surveyId;
    await runAsync(
        'UPDATE surveys SET base_survey_id = ?, parent_survey_id = ?, version = ?, is_draft = ? WHERE id = ?',
        [lineage.baseSurveyId == null ? id : lineage.baseSurveyId, lineage.parentSurveyId ?? null,
         lineage.version ?? result.version, lineage.isDraft === undefined ? 1 : (lineage.isDraft ? 1 : 0), id]
    );
    return { surveyId: id, name: bundle.survey.name, version: lineage.version ?? result.version, counts: result.counts };
}

/** Next version number in a survey's lineage (all surveys sharing its base). */
async function nextVersion(baseId, excludeId = 0) {
    const max = await getAsync('SELECT MAX(version) v FROM surveys WHERE (base_survey_id = ? OR id = ?) AND id != ?',
        [baseId, baseId, excludeId]);
    return (max && max.v ? max.v : 0) + 1;
}

/**
 * New inactive version of any survey (including the active one), linked to
 * it. With a different name, a separate survey that records the source as
 * its parent. (MCP copy_survey.)
 */
async function copySurvey(sourceId, { name } = {}, ctx = {}) {
    const source = await loadSurvey(sourceId);
    const linked = !name || name === source.name;
    const baseId = source.base_survey_id || source.id;
    const result = await cloneSurvey(sourceId, {
        overrides: name ? { name } : {},
        lineage: linked
            ? { baseSurveyId: baseId, parentSurveyId: sourceId, version: await nextVersion(baseId) }
            : { baseSurveyId: null, parentSurveyId: sourceId, version: 1 }
    });
    await audit(ctx, 'COPY_SURVEY', 'survey', result.surveyId, null,
        { from_survey_id: sourceId, name: result.name, version: result.version });
    return result;
}

/**
 * The web editor's "copy survey" (POST /survey-config with basedOnSurveyId):
 * a new, separate survey at version 1, with the given name and optional
 * description/languages, and every setting and question of the source.
 */
async function copyAsNewSurvey(sourceId, { name, description, languages }, ctx = {}) {
    await loadSurvey(sourceId);
    const overrides = { name };
    if (description !== undefined) overrides.description = description;
    if (languages) overrides.languages = languages;
    const result = await cloneSurvey(sourceId, {
        overrides,
        lineage: { baseSurveyId: null, parentSurveyId: null, version: 1, isDraft: false }
    });
    await audit(ctx, 'CREATE_SURVEY', 'survey', result.surveyId, null,
        { name, description, version: 1, based_on_survey_id: sourceId });
    return result;
}

/**
 * The web editor's "save as new version" (PUT /survey-config/:id with
 * create_version): the next version in the source's lineage, with `changes`
 * (survey settings) applied.
 */
async function createVersion(sourceId, changes, ctx = {}) {
    const source = await loadSurvey(sourceId);
    const baseId = source.base_survey_id || source.id;
    const version = await nextVersion(baseId);
    const result = await cloneSurvey(sourceId, {
        overrides: changes,
        lineage: { baseSurveyId: baseId, parentSurveyId: sourceId, version, isDraft: false }
    });
    await audit(ctx, 'CREATE_SURVEY_VERSION', 'survey', result.surveyId, source, { version, changes });
    return result;
}

/** Replaces an inactive survey's contents, guarded by expected_updated_at. */
async function replaceSurvey(surveyId, bundle, expectedUpdatedAt, ctx = {}) {
    const survey = await loadSurvey(surveyId, { ...ctx, requireInactive: true });
    if (!expectedUpdatedAt || String(expectedUpdatedAt) !== String(survey.updated_at)) {
        throw new EditError(409,
            `Survey ${surveyId} has changed since it was read (updated_at is now ${survey.updated_at}). ` +
            'Read it again with get_survey, reapply the changes, and pass the new updated_at.');
    }
    let result;
    try { result = await replaceSurveyContents(dbx, surveyId, bundle); } catch (err) { throw bundleError(err); }
    const after = await getAsync('SELECT updated_at FROM surveys WHERE id = ?', [surveyId]);
    await audit(ctx, 'REPLACE_SURVEY', 'survey', surveyId,
        { name: survey.name, updated_at: survey.updated_at },
        { name: bundle.survey && bundle.survey.name, counts: result.counts });
    return { ...result, updated_at: after.updated_at };
}

module.exports = {
    EditError,
    QUESTION_TYPES,
    STANDARD_MESSAGE_KEYS,
    MAX_AUDIO_BYTES,
    jexlReport,
    loadSurvey,
    addQuestion,
    updateQuestion,
    deleteQuestion,
    reorderQuestions,
    moveQuestion,
    updateSurveySettings,
    updateSection,
    setMessage,
    isKnownMessageKey,
    setAudio,
    surveyAudioBytes,
    createSurveyFromBundle,
    copySurvey,
    copyAsNewSurvey,
    createVersion,
    replaceSurvey,
    _internal: { decodeMp3, normalizeOptions }
};
