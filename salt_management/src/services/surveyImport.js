/**
 * Shared survey-import logic.
 *
 * Inserts a survey export bundle (schema_version 1) — the surveys row plus its
 * sections, questions, options, survey_messages and test_configurations —
 * reassigning every internal id and remapping intra-bundle references. Runs in
 * a single BEGIN/COMMIT transaction; rolls back on any failure.
 *
 * Used by:
 *   - POST /api/admin/surveys/import   (admin upload — imports an inactive draft)
 *   - scripts/init-database.js         (fresh-deploy seed — imports active)
 *   - services/surveyEditing.js        (MCP create_survey / copy_survey / replace_survey)
 *
 * Connection-agnostic: callers pass a `dbx` with Promise-returning
 *   run(sql, params) -> { id, changes }   and   all(sql, params) -> rows
 * bound to whatever sqlite handle they own, so this module never opens its own.
 */

const { isOtherFlag, validateOtherOptions, otherNameClash } = require('./otherOption');

const SCHEMA_VERSION = 1;

// Columns copied from the bundle's survey object. is_active / is_draft /
// version / base_survey_id / parent_survey_id are overridden on insert.
const SURVEY_COLUMNS = [
    'name', 'description', 'languages', 'version', 'is_active', 'eligibility_script',
    'eligibility_message_json', 'base_survey_id', 'parent_survey_id', 'version_notes',
    'is_draft', 'fingerprint_enabled', 're_enrollment_days',
    'staff_validation_message_json', 'hiv_rapid_test_enabled', 'contact_info_enabled',
    'staff_eligibility_screening', 'rapid_test_samples_after_eligibility',
    'payment_audit_phone_enabled', 'coupon_count_script'
];

// Survey columns a replacement may change. Status and lineage stay as they are.
const REPLACEABLE_SURVEY_COLUMNS = SURVEY_COLUMNS.filter(c =>
    !['version', 'is_active', 'is_draft', 'base_survey_id', 'parent_survey_id'].includes(c));

// Validation failures carry `.validation = true` so HTTP callers can map them
// to 400 (vs 500 for an unexpected insert failure).
function validationError(message) {
    return Object.assign(new Error(message), { validation: true });
}

// JSON columns are stored as text. Bundles exported by SALT carry strings; a
// bundle written by hand or by an AI may carry objects, so accept both.
function jsonText(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Checks a bundle and returns its parts. Throws a validation error (see
 * validationError) describing the first problem found.
 */
function validateBundle(bundle) {
    if (!bundle || typeof bundle !== 'object') {
        throw validationError('Body must be a survey export JSON object');
    }
    if (bundle.schema_version !== SCHEMA_VERSION) {
        throw validationError(
            `Unsupported schema_version ${bundle.schema_version} — this server expects ${SCHEMA_VERSION}.`
        );
    }
    const src = bundle.survey;
    if (!src || typeof src !== 'object' || !src.name) {
        throw validationError('Bundle is missing the survey object');
    }
    const srcQuestions = Array.isArray(bundle.questions) ? bundle.questions : [];
    if (srcQuestions.length === 0) {
        throw validationError('Bundle has no questions');
    }
    // `value` is a reserved short_name — it is the JEXL variable bound to the
    // current answer in validation_script / skip_to_script, so a question
    // named `value` would shadow it.
    if (srcQuestions.some(q => q.short_name === 'value')) {
        throw validationError(
            'A question uses the reserved short_name "value". Rename it — '
            + '"value" is the JEXL variable bound to the current answer in '
            + 'validation and skip-to scripts.'
        );
    }
    // `facility_coupons` is reserved — it is the facility coupon ceiling bound
    // in the coupon_count_script context.
    if (srcQuestions.some(q => q.short_name === 'facility_coupons')) {
        throw validationError(
            'A question uses the reserved short_name "facility_coupons". Rename it — '
            + '"facility_coupons" is the JEXL variable bound to the facility coupon '
            + 'ceiling in the coupon count script.'
        );
    }
    // Scripts refer to questions by short_name, so two questions sharing one
    // would make every reference ambiguous.
    const seenNames = new Set();
    for (const q of srcQuestions) {
        if (seenNames.has(q.short_name)) {
            throw validationError(`Two questions use the short_name "${q.short_name}". Short names must be unique.`);
        }
        seenNames.add(q.short_name);
    }
    const srcSections = Array.isArray(bundle.sections) ? bundle.sections : [];
    // Every survey has exactly two sections, eligibility and main; tablets
    // support no others (eligibility runs when the participant leaves it).
    const sectionTypes = srcSections.map(s => s.section_type);
    for (const type of ['eligibility', 'main']) {
        const n = sectionTypes.filter(t => t === type).length;
        if (n !== 1) {
            throw validationError(n === 0
                ? `The bundle has no "${type}" section. Every survey has exactly two sections: eligibility and main.`
                : `The bundle has ${n} "${type}" sections. Every survey has exactly one eligibility and one main section.`);
        }
    }
    const extraTypes = sectionTypes.filter(t => t !== 'eligibility' && t !== 'main');
    if (extraTypes.length) {
        throw validationError(`Sections can only be eligibility and main, not ${extraTypes.map(t => `"${t}"`).join(', ')}.`);
    }
    const srcOptions = Array.isArray(bundle.options) ? bundle.options : [];
    const srcMessages = Array.isArray(bundle.survey_messages) ? bundle.survey_messages : [];
    const srcTestConfigs = Array.isArray(bundle.test_configurations) ? bundle.test_configurations : [];

    // "Other, specify" options: at most one per choice question, and the
    // derived <short_name>_other names must not clash with real short names.
    // Bundles without is_other import every option as a normal option.
    const otherChecks = srcQuestions.map(q => {
        const opts = srcOptions.filter(o => o.question_id === q.id);
        const error = validateOtherOptions(q.question_type, opts);
        if (error) throw validationError(`Question "${q.short_name}": ${error}`);
        return { short_name: q.short_name, has_other: opts.some(o => isOtherFlag(o.is_other)) };
    });
    for (const q of otherChecks) {
        const clash = otherNameClash(q, otherChecks.filter(o => o !== q));
        if (clash) throw validationError(clash);
    }

    return { src, srcSections, srcQuestions, srcOptions, srcMessages, srcTestConfigs };
}

/**
 * Inserts a bundle's sections, questions, options, messages and test
 * configurations under `surveyId`, remapping bundle-local ids. Runs inside the
 * caller's transaction. Returns warnings about dropped references.
 */
async function insertSurveyContents(dbx, surveyId, parts) {
    const { srcSections, srcQuestions, srcOptions, srcMessages, srcTestConfigs } = parts;
    const warnings = [];

    // Sections — remap section ids.
    const sectionIdMap = new Map();
    for (const s of srcSections) {
        const r = await dbx.run(
            `INSERT INTO sections (survey_id, section_index, section_type, name, description)
             VALUES (?, ?, ?, ?, ?)`,
            [surveyId, s.section_index, s.section_type, s.name, s.description || null]
        );
        sectionIdMap.set(s.id, r.id);
    }

    // Questions — remap survey_id + section_id.
    const questionIdMap = new Map();
    for (const q of srcQuestions) {
        const remappedSection = q.section_id != null ? sectionIdMap.get(q.section_id) || null : null;
        if (q.section_id != null && remappedSection == null) {
            warnings.push(`Question "${q.short_name}" referenced section_id ${q.section_id} that wasn't in the bundle; section reference dropped.`);
        }
        const r = await dbx.run(
            `INSERT INTO questions (
                survey_id, question_index, short_name, question_text_json,
                audio_files_json, question_type, validation_script,
                validation_error_json, pre_script, section_id,
                min_selections, max_selections, skip_to_script, skip_to_target
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                surveyId, q.question_index, q.short_name, jsonText(q.question_text_json, '{}'),
                jsonText(q.audio_files_json, '{}'), q.question_type, q.validation_script || null,
                jsonText(q.validation_error_json, null), q.pre_script || null, remappedSection,
                q.min_selections == null ? null : q.min_selections,
                q.max_selections == null ? null : q.max_selections,
                q.skip_to_script || null, q.skip_to_target || null
            ]
        );
        questionIdMap.set(q.id, r.id);
    }

    // Options — remap question_id; drop orphans. option_value in older bundles is ignored.
    for (const o of srcOptions) {
        const remappedQuestion = questionIdMap.get(o.question_id);
        if (!remappedQuestion) continue;
        await dbx.run(
            `INSERT INTO options (question_id, option_index, option_text_json, audio_files_json, is_other)
             VALUES (?, ?, ?, ?, ?)`,
            [remappedQuestion, o.option_index, jsonText(o.option_text_json, '{}'), jsonText(o.audio_files_json, '{}'),
             isOtherFlag(o.is_other) ? 1 : 0]
        );
    }

    // Survey messages — remap survey_id.
    for (const m of srcMessages) {
        await dbx.run(
            `INSERT INTO survey_messages
                (survey_id, message_key, display_order, message_text_json, audio_files_json, message_type)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [surveyId, m.message_key, m.display_order || 0,
             jsonText(m.message_text_json, '{}'), jsonText(m.audio_files_json, '{}'), m.message_type || 'system']
        );
    }

    // Test configurations — remap survey_id.
    for (const t of srcTestConfigs) {
        await dbx.run(
            `INSERT INTO test_configurations (survey_id, test_id, test_name, enabled, display_order)
             VALUES (?, ?, ?, ?, ?)`,
            [surveyId, t.test_id, t.test_name, t.enabled ? 1 : 0, t.display_order || 0]
        );
    }
    return warnings;
}

function countsOf(parts) {
    return {
        sections: parts.srcSections.length,
        questions: parts.srcQuestions.length,
        options: parts.srcOptions.length,
        survey_messages: parts.srcMessages.length,
        test_configurations: parts.srcTestConfigs.length
    };
}

/**
 * @param {{run:Function, all:Function}} dbx  connection adapter
 * @param {object} bundle                     parsed export bundle
 * @param {{activate?:boolean}} [opts]        activate=true => is_active=1,is_draft=0
 * @returns {Promise<{surveyId,name,version,counts,warnings}>}
 */
async function importSurveyBundle(dbx, bundle, opts = {}) {
    const activate = opts.activate === true;
    const parts = validateBundle(bundle);
    const { src, srcTestConfigs } = parts;

    const warnings = [];

    // Pick a version that won't collide with an existing (name, version) pair.
    let importVersion = src.version || 1;
    const existing = await dbx.all(
        'SELECT version FROM surveys WHERE name = ? ORDER BY version DESC', [src.name]
    );
    if (existing.length) {
        importVersion = (existing[0].version || 0) + 1;
        warnings.push(`Survey named "${src.name}" already exists; imported as version ${importVersion}.`);
    }

    if (srcTestConfigs.length) {
        const bundleTestIds = srcTestConfigs.map(t => t.test_id).filter(Boolean);
        warnings.push(`Imported ${bundleTestIds.length} rapid test configuration(s); verify they match the tablet build's rapid test ids.`);
    }
    warnings.push('Lab test configurations are global to this deployment and were NOT included in the bundle — configure them via the Lab Tests admin if needed.');

    try {
        await dbx.run('BEGIN');

        // Survey row — force the fields that must not be copied verbatim.
        const surveyVals = SURVEY_COLUMNS.map(col => {
            switch (col) {
                case 'is_active': return activate ? 1 : 0;
                case 'is_draft': return activate ? 0 : 1;
                case 'version': return importVersion;
                case 'base_survey_id':
                case 'parent_survey_id': return null;
                case 'languages':
                case 'eligibility_message_json':
                case 'staff_validation_message_json':
                    return col in src ? jsonText(src[col], null) : null;
                default: return col in src ? src[col] : null;
            }
        });
        const placeholders = SURVEY_COLUMNS.map(() => '?').join(',');
        const surveyInsert = await dbx.run(
            `INSERT INTO surveys (${SURVEY_COLUMNS.join(',')}) VALUES (${placeholders})`,
            surveyVals
        );
        const newSurveyId = surveyInsert.id;

        warnings.push(...await insertSurveyContents(dbx, newSurveyId, parts));

        await dbx.run('COMMIT');

        return {
            surveyId: newSurveyId,
            name: src.name,
            version: importVersion,
            counts: countsOf(parts),
            warnings
        };
    } catch (err) {
        try { await dbx.run('ROLLBACK'); } catch (_) { /* ignore */ }
        throw err;
    }
}

/**
 * Replaces an existing survey's settings and contents with a bundle's, in one
 * transaction. The survey keeps its id, version, status and lineage. Callers
 * are responsible for refusing active surveys.
 * @returns {Promise<{surveyId,counts,warnings}>}
 */
async function replaceSurveyContents(dbx, surveyId, bundle) {
    const parts = validateBundle(bundle);
    const { src } = parts;
    try {
        await dbx.run('BEGIN');
        const cols = REPLACEABLE_SURVEY_COLUMNS.filter(c => c in src);
        if (cols.length) {
            const vals = cols.map(c => ['languages', 'eligibility_message_json', 'staff_validation_message_json'].includes(c)
                ? jsonText(src[c], null) : src[c]);
            await dbx.run(
                `UPDATE surveys SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`,
                [...vals, surveyId]
            );
        }
        await dbx.run('DELETE FROM options WHERE question_id IN (SELECT id FROM questions WHERE survey_id = ?)', [surveyId]);
        await dbx.run('DELETE FROM questions WHERE survey_id = ?', [surveyId]);
        await dbx.run('DELETE FROM sections WHERE survey_id = ?', [surveyId]);
        await dbx.run('DELETE FROM survey_messages WHERE survey_id = ?', [surveyId]);
        await dbx.run('DELETE FROM test_configurations WHERE survey_id = ?', [surveyId]);
        const warnings = await insertSurveyContents(dbx, surveyId, parts);
        await dbx.run("UPDATE surveys SET updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?", [surveyId]);
        await dbx.run('COMMIT');
        return { surveyId, counts: countsOf(parts), warnings };
    } catch (err) {
        try { await dbx.run('ROLLBACK'); } catch (_) { /* ignore */ }
        throw err;
    }
}

module.exports = { importSurveyBundle, replaceSurveyContents, validateBundle, SCHEMA_VERSION, SURVEY_COLUMNS };
