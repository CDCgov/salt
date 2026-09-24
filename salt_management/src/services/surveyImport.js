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
 *
 * Connection-agnostic: callers pass a `dbx` with Promise-returning
 *   run(sql, params) -> { id, changes }   and   all(sql, params) -> rows
 * bound to whatever sqlite handle they own, so this module never opens its own.
 */

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

// Validation failures carry `.validation = true` so HTTP callers can map them
// to 400 (vs 500 for an unexpected insert failure).
function validationError(message) {
    return Object.assign(new Error(message), { validation: true });
}

/**
 * @param {{run:Function, all:Function}} dbx  connection adapter
 * @param {object} bundle                     parsed export bundle
 * @param {{activate?:boolean}} [opts]        activate=true => is_active=1,is_draft=0
 * @returns {Promise<{surveyId,name,version,counts,warnings}>}
 */
async function importSurveyBundle(dbx, bundle, opts = {}) {
    const activate = opts.activate === true;

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
    const srcSections = Array.isArray(bundle.sections) ? bundle.sections : [];
    const srcOptions = Array.isArray(bundle.options) ? bundle.options : [];
    const srcMessages = Array.isArray(bundle.survey_messages) ? bundle.survey_messages : [];
    const srcTestConfigs = Array.isArray(bundle.test_configurations) ? bundle.test_configurations : [];

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
                default: return col in src ? src[col] : null;
            }
        });
        const placeholders = SURVEY_COLUMNS.map(() => '?').join(',');
        const surveyInsert = await dbx.run(
            `INSERT INTO surveys (${SURVEY_COLUMNS.join(',')}) VALUES (${placeholders})`,
            surveyVals
        );
        const newSurveyId = surveyInsert.id;

        // Sections — remap section ids.
        const sectionIdMap = new Map();
        for (const s of srcSections) {
            const r = await dbx.run(
                `INSERT INTO sections (survey_id, section_index, section_type, name, description)
                 VALUES (?, ?, ?, ?, ?)`,
                [newSurveyId, s.section_index, s.section_type, s.name, s.description || null]
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
                    newSurveyId, q.question_index, q.short_name, q.question_text_json,
                    q.audio_files_json || '{}', q.question_type, q.validation_script || null,
                    q.validation_error_json || null, q.pre_script || null, remappedSection,
                    q.min_selections == null ? null : q.min_selections,
                    q.max_selections == null ? null : q.max_selections,
                    q.skip_to_script || null, q.skip_to_target || null
                ]
            );
            questionIdMap.set(q.id, r.id);
        }

        // Options — remap question_id; drop orphans.
        for (const o of srcOptions) {
            const remappedQuestion = questionIdMap.get(o.question_id);
            if (!remappedQuestion) continue;
            await dbx.run(
                `INSERT INTO options (question_id, option_index, option_text_json, audio_files_json, option_value)
                 VALUES (?, ?, ?, ?, ?)`,
                [remappedQuestion, o.option_index, o.option_text_json, o.audio_files_json || '{}', o.option_value || null]
            );
        }

        // Survey messages — remap survey_id.
        for (const m of srcMessages) {
            await dbx.run(
                `INSERT INTO survey_messages
                    (survey_id, message_key, display_order, message_text_json, audio_files_json, message_type)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [newSurveyId, m.message_key, m.display_order || 0,
                 m.message_text_json, m.audio_files_json || '{}', m.message_type || 'system']
            );
        }

        // Test configurations — remap survey_id.
        for (const t of srcTestConfigs) {
            await dbx.run(
                `INSERT INTO test_configurations (survey_id, test_id, test_name, enabled, display_order)
                 VALUES (?, ?, ?, ?, ?)`,
                [newSurveyId, t.test_id, t.test_name, t.enabled ? 1 : 0, t.display_order || 0]
            );
        }

        await dbx.run('COMMIT');

        return {
            surveyId: newSurveyId,
            name: src.name,
            version: importVersion,
            counts: {
                sections: srcSections.length,
                questions: srcQuestions.length,
                options: srcOptions.length,
                survey_messages: srcMessages.length,
                test_configurations: srcTestConfigs.length
            },
            warnings
        };
    } catch (err) {
        try { await dbx.run('ROLLBACK'); } catch (_) { /* ignore */ }
        throw err;
    }
}

module.exports = { importSurveyBundle, SCHEMA_VERSION, SURVEY_COLUMNS };
