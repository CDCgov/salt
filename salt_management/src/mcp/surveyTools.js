/**
 * surveyTools.js — MCP tools for reading and editing surveys and lab tests.
 *
 * Thin wrappers over the shared services (services/surveyEditing.js,
 * services/labTestEditing.js, services/surveyBundle.js, services/jexlCheck.js),
 * so the AI and the web editor apply the same rules. No SQL for edits lives here.
 *
 * Rules (see SALT_IMPROVEMENT_PLAN.md item 2):
 *   - Survey write tools refuse a survey with is_active = 1. To change the
 *     live survey: copy_survey, edit the copy, and a person activates it in
 *     the web app. There is no activation tool.
 *   - Every survey write returns the item 1 script check for what it touched.
 *   - Lab tests are global; changes to active tests say they reach every facility.
 *   - All writes are audited with via: 'mcp'.
 */

const { z } = require('zod');

const { allAsync, getAsync } = require('../models/database');
const database = require('../models/database');
const editing = require('../services/surveyEditing');
const labEditing = require('../services/labTestEditing');
const { buildSurveyBundle } = require('../services/surveyBundle');
const { checkSurvey } = require('../services/jexlCheck');
const { getSurveyAuthoringGuide } = require('../services/surveyAuthoringGuide');

const { EditError, jexlReport } = editing;

const json = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const errorText = (s) => ({ content: [{ type: 'text', text: String(s) }], isError: true });

function userIdFrom(extra) {
    return extra && extra.authInfo && extra.authInfo.extra ? extra.authInfo.extra.userId : null;
}

const mcpCtx = (extra) => ({ userId: userIdFrom(extra), via: 'mcp', requireInactive: true });

// Runs a tool body, turning EditError into a tool error the AI can act on.
function handle(fn) {
    return async (args, extra) => {
        try {
            return await fn(args, extra);
        } catch (err) {
            if (err instanceof EditError) return errorText(err.message);
            console.error('[mcp] survey tool failed:', err);
            return errorText(`Failed: ${err.message}`);
        }
    };
}

async function updatedAt(surveyId) {
    const row = await getAsync('SELECT updated_at FROM surveys WHERE id = ?', [surveyId]);
    return row ? row.updated_at : null;
}

function parseJson(text, fallback) {
    if (text && typeof text === 'object') return text;
    try { return JSON.parse(text || ''); } catch { return fallback; }
}

/** The item 1 check plus an audio summary: total size and what lacks audio. */
async function fullCheck(surveyId) {
    const check = await checkSurvey(database, surveyId);
    if (!check) return null;
    const survey = await getAsync('SELECT languages FROM surveys WHERE id = ?', [surveyId]);
    const languages = parseJson(survey.languages, []) || [];
    const missing = {};
    const items = [];
    const note = (label, audioJson) => {
        const audio = parseJson(audioJson, {}) || {};
        for (const lang of languages) {
            if (!audio[lang]) {
                missing[lang] = (missing[lang] || 0) + 1;
                if (items.length < 50) items.push(`${label} (${lang})`);
            }
        }
    };
    const questions = await allAsync(
        "SELECT id, short_name, question_type, audio_files_json FROM questions WHERE survey_id = ? ORDER BY question_index", [surveyId]);
    for (const q of questions) {
        note(`question ${q.short_name}`, q.audio_files_json);
        const opts = await allAsync('SELECT option_index, audio_files_json FROM options WHERE question_id = ? ORDER BY option_index', [q.id]);
        for (const o of opts) note(`option ${o.option_index} of ${q.short_name}`, o.audio_files_json);
    }
    const messages = await allAsync('SELECT message_key, audio_files_json FROM survey_messages WHERE survey_id = ?', [surveyId]);
    for (const m of messages) note(`message ${m.message_key}`, m.audio_files_json);
    const bytes = await editing.surveyAudioBytes(surveyId);
    return {
        ...check,
        audio: {
            total_mb: Math.round(bytes / 10485.76) / 100,
            note: 'Every tablet downloads all of this audio with the survey.',
            missing_by_language: missing,
            missing_examples: items
        }
    };
}

// Fields an AI may set on a question (database column names, as get_survey returns them).
const questionFields = {
    short_name: z.string().optional().describe('Variable name used in scripts and exports: letters, numbers, underscores; unique in the survey'),
    question_type: z.enum(editing.QUESTION_TYPES).optional(),
    question_text_json: z.record(z.string(), z.string()).optional().describe('Question text per survey language, e.g. {"English": "...", "French": "..."}. Markdown allowed.'),
    pre_script: z.string().nullable().optional().describe('Skip logic: JEXL; when it is TRUE the question is HIDDEN'),
    validation_script: z.string().nullable().optional().describe('JEXL that must be true for the answer to be accepted; the answer is `value`'),
    validation_error_json: z.record(z.string(), z.string()).optional().describe('Error message per language shown when validation fails'),
    skip_to_script: z.string().nullable().optional().describe('JEXL; when true after answering, jump to skip_to_target'),
    skip_to_target: z.string().nullable().optional().describe('short_name of a LATER question'),
    section_id: z.number().int().optional().describe('Section id from get_survey (eligibility or main)'),
    min_selections: z.number().int().nullable().optional(),
    max_selections: z.number().int().nullable().optional(),
};

const optionSchema = z.object({
    text: z.record(z.string(), z.string()).describe('Option text per survey language'),
    is_other: z.boolean().optional().describe('The "other, specify" option (at most one per question); its free text is <short_name>_other'),
});

const questionRef = z.union([z.number().int(), z.string()]).describe('Question id, or its short_name');

function toServiceOptions(options) {
    return options.map((o, i) => ({ option_index: i, text_json: o.text, is_other: o.is_other ? 1 : 0 }));
}

function registerSurveyTools(server) {
    // ---- read -------------------------------------------------------------

    server.registerTool('get_survey_authoring_guide', {
        title: 'Get survey authoring guide',
        description: 'CALL THIS FIRST before creating or editing a survey or lab test. Rules for SALT survey logic (JEXL), structure, system messages and the editing workflow.',
        inputSchema: {},
    }, async () => ({ content: [{ type: 'text', text: getSurveyAuthoringGuide() }] }));

    server.registerTool('get_survey', {
        title: 'Get survey',
        description: 'A survey in the export-bundle format (survey, sections, questions, options, survey_messages, test_configurations). Audio is replaced by per-language `true` flags unless include_audio is true. survey.updated_at is what replace_survey\'s expected_updated_at must match.',
        inputSchema: {
            surveyId: z.number().int(),
            include_audio: z.boolean().optional().describe('Include the base64 audio (large). Default false.'),
        },
    }, handle(async ({ surveyId, include_audio = false }) => {
        const bundle = await buildSurveyBundle(surveyId, { includeAudio: include_audio });
        if (!bundle) return errorText(`Survey ${surveyId} not found.`);
        return json(bundle);
    }));

    server.registerTool('check_survey', {
        title: 'Check survey',
        description: 'Checks every script in a survey with the tablet\'s JEXL engine plus SALT survey rules (syntax, unknown names, skipped answers, option numbers, skip-to targets, translations), and summarises audio. Errors block activation; fix them all before telling the user the survey is ready.',
        inputSchema: { surveyId: z.number().int() },
    }, handle(async ({ surveyId }) => {
        const result = await fullCheck(surveyId);
        if (!result) return errorText(`Survey ${surveyId} not found.`);
        return json(result);
    }));

    server.registerTool('list_lab_tests', {
        title: 'List lab tests',
        description: 'All lab test configurations (global to this deployment), including inactive ones, with how many results each has.',
        inputSchema: {},
    }, handle(async () => {
        const rows = await allAsync(
            `SELECT l.*, (SELECT COUNT(*) FROM lab_results r WHERE r.test_id = l.id) AS result_count
             FROM lab_test_configurations l ORDER BY l.display_order, l.id`);
        rows.forEach(r => { r.options = parseJson(r.options, null); });
        return json(rows);
    }));

    server.registerTool('get_lab_test', {
        title: 'Get lab test',
        description: 'One lab test configuration, with its result count and a check of its JEXL condition.',
        inputSchema: { labTestId: z.number().int() },
    }, handle(async ({ labTestId }) => {
        const row = await getAsync(
            `SELECT l.*, (SELECT COUNT(*) FROM lab_results r WHERE r.test_id = l.id) AS result_count
             FROM lab_test_configurations l WHERE l.id = ?`, [labTestId]);
        if (!row) return errorText(`Lab test ${labTestId} not found.`);
        row.options = parseJson(row.options, null);
        return json({ ...row, jexl_check: await labEditing.labConditionReport(labTestId) });
    }));

    // ---- whole surveys ------------------------------------------------------

    server.registerTool('create_survey', {
        title: 'Create survey from bundle',
        description: 'Creates a new INACTIVE survey from a full bundle in the get_survey format (schema_version 1). Ids inside the bundle are local and only link sections/questions/options. Needs an "eligibility" and a "main" section. Returns the new surveyId and the script check.',
        inputSchema: { bundle: z.object({}).passthrough().describe('Survey bundle (see get_survey for the shape)') },
    }, handle(async ({ bundle }, extra) => {
        const result = await editing.createSurveyFromBundle(bundle, mcpCtx(extra));
        return json({ surveyId: result.surveyId, name: result.name, version: result.version, counts: result.counts,
            warnings: result.warnings, updated_at: await updatedAt(result.surveyId), check: await fullCheck(result.surveyId) });
    }));

    server.registerTool('copy_survey', {
        title: 'Copy survey',
        description: 'Makes a new INACTIVE version of any survey, including the active one, with everything in it (questions, options, messages, rapid tests, audio). This is how to change the live survey: copy, edit the copy, then a person activates it in the web app. Pass name to start a separate survey instead of a new version.',
        inputSchema: {
            surveyId: z.number().int(),
            name: z.string().optional().describe('Name for the copy. Leave out for a new version of the same survey.'),
        },
    }, handle(async ({ surveyId, name }, extra) => {
        const result = await editing.copySurvey(surveyId, { name }, mcpCtx(extra));
        return json({ ...result, updated_at: await updatedAt(result.surveyId) });
    }));

    server.registerTool('replace_survey', {
        title: 'Replace survey (full rewrite)',
        description: 'Replaces ALL of an inactive survey\'s settings and contents with a bundle. Use ONLY for deliberate wholesale rewrites; use the targeted tools for normal edits. expected_updated_at must equal survey.updated_at from your latest get_survey, or the call is refused.',
        inputSchema: {
            surveyId: z.number().int(),
            bundle: z.object({}).passthrough(),
            expected_updated_at: z.string(),
        },
    }, handle(async ({ surveyId, bundle, expected_updated_at }, extra) => {
        const result = await editing.replaceSurvey(surveyId, bundle, expected_updated_at, mcpCtx(extra));
        return json({ ...result, check: await fullCheck(surveyId) });
    }));

    // ---- targeted survey edits ----------------------------------------------

    server.registerTool('update_survey_settings', {
        title: 'Update survey settings',
        description: 'Changes settings of an inactive survey: name, description, languages, eligibility and coupon count scripts, messages stored on the survey, feature flags, and this survey\'s rapid tests (enable/disable, order).',
        inputSchema: {
            surveyId: z.number().int(),
            settings: z.object({
                name: z.string().optional(),
                description: z.string().optional(),
                languages: z.array(z.string()).optional().describe('Language names used as keys in all text objects, e.g. ["English","French"]'),
                eligibility_script: z.string().nullable().optional().describe('JEXL over eligibility-section answers; true = eligible'),
                coupon_count_script: z.string().nullable().optional().describe('JEXL; number of coupons to issue (never above facility_coupons)'),
                eligibility_message_json: z.record(z.string(), z.string()).optional(),
                staff_validation_message_json: z.record(z.string(), z.string()).optional(),
                fingerprint_enabled: z.boolean().optional(),
                re_enrollment_days: z.number().int().optional(),
                contact_info_enabled: z.boolean().optional(),
                staff_eligibility_screening: z.boolean().optional(),
                rapid_test_samples_after_eligibility: z.boolean().optional(),
                payment_audit_phone_enabled: z.boolean().optional(),
            }).optional(),
            rapid_tests: z.array(z.object({
                test_id: z.string(),
                enabled: z.boolean().optional(),
                display_order: z.number().int().optional(),
            })).optional().describe('Changes to this survey\'s existing rapid test configurations'),
        },
    }, handle(async ({ surveyId, settings = {}, rapid_tests }, extra) => {
        await editing.updateSurveySettings(surveyId, settings, mcpCtx(extra), { rapidTests: rapid_tests });
        return json({ surveyId, updated_at: await updatedAt(surveyId),
            jexl_check: await jexlReport(surveyId, { fields: ['eligibility_script', 'coupon_count_script'] }) });
    }));

    server.registerTool('add_question', {
        title: 'Add question',
        description: 'Adds a question to an inactive survey. Option positions start at 0 and are what scripts compare (q == 0 means the first option). Returns the script check for the new question.',
        inputSchema: {
            surveyId: z.number().int(),
            question: z.object({
                ...questionFields,
                short_name: z.string(),
                question_type: z.enum(editing.QUESTION_TYPES),
                question_text_json: z.record(z.string(), z.string()),
                options: z.array(optionSchema).optional(),
            }),
            position: z.number().int().optional().describe('0-based position; later questions move down. Default: at the end.'),
        },
    }, handle(async ({ surveyId, question, position }, extra) => {
        const fields = { ...question, options: toServiceOptions(question.options || []), position };
        const result = await editing.addQuestion(surveyId, fields, mcpCtx(extra));
        return json({ questionId: result.id, position: result.question_index, updated_at: await updatedAt(surveyId),
            jexl_check: await jexlReport(surveyId, { questionId: result.id }) });
    }));

    server.registerTool('update_question', {
        title: 'Update question',
        description: 'Changes fields of a question in an inactive survey. Fields left out are unchanged; send null to clear a script. Use set_options for options and move_question to reorder.',
        inputSchema: { surveyId: z.number().int(), question: questionRef, changes: z.object(questionFields) },
    }, handle(async ({ surveyId, question, changes }, extra) => {
        const result = await editing.updateQuestion(surveyId, question, changes, mcpCtx(extra));
        return json({ questionId: result.id, updated_at: await updatedAt(surveyId),
            jexl_check: await jexlReport(surveyId, { questionId: result.id }) });
    }));

    server.registerTool('delete_question', {
        title: 'Delete question',
        description: 'Deletes a question (and its options) from an inactive survey. Scripts that refer to it will then fail the check; the result lists them.',
        inputSchema: { surveyId: z.number().int(), question: questionRef },
    }, handle(async ({ surveyId, question }, extra) => {
        const result = await editing.deleteQuestion(surveyId, question, mcpCtx(extra));
        const check = await checkSurvey(database, surveyId);
        return json({ deleted: result, updated_at: await updatedAt(surveyId),
            survey_errors: check ? check.errors : null });
    }));

    server.registerTool('move_question', {
        title: 'Move question',
        description: 'Moves a question to a 0-based position, optionally into another section. Moving a question can make scripts refer to questions asked later; the result includes the check.',
        inputSchema: {
            surveyId: z.number().int(),
            question: questionRef,
            position: z.number().int(),
            section_id: z.number().int().optional(),
        },
    }, handle(async ({ surveyId, question, position, section_id }, extra) => {
        const result = await editing.moveQuestion(surveyId, question, position, mcpCtx(extra), { sectionId: section_id });
        return json({ ...result, updated_at: await updatedAt(surveyId),
            jexl_check: await jexlReport(surveyId, { questionId: result.id }) });
    }));

    server.registerTool('set_options', {
        title: 'Set options',
        description: 'Replaces all options of a multiple_choice or multi_select question. Scripts compare option POSITIONS (0, 1, 2, ...), so reordering or inserting options changes what existing scripts mean; check the result. Audio stays with the option position.',
        inputSchema: { surveyId: z.number().int(), question: questionRef, options: z.array(optionSchema) },
    }, handle(async ({ surveyId, question, options }, extra) => {
        const result = await editing.updateQuestion(surveyId, question, { options: toServiceOptions(options) },
            mcpCtx(extra), { keepOptionAudio: true });
        return json({ questionId: result.id, option_count: options.length, updated_at: await updatedAt(surveyId),
            jexl_check: await jexlReport(surveyId, { questionId: result.id }) });
    }));

    server.registerTool('update_section', {
        title: 'Update section',
        description: 'Renames a section or changes its description. Surveys have exactly two sections, eligibility and main; tablets support no others, so sections can\'t be added or deleted.',
        inputSchema: {
            surveyId: z.number().int(),
            sectionId: z.number().int(),
            name: z.string().optional(),
            description: z.string().nullable().optional(),
        },
    }, handle(async ({ surveyId, sectionId, name, description }, extra) => {
        await editing.updateSection(surveyId, sectionId, { name, description }, mcpCtx(extra));
        return json({ sectionId, updated_at: await updatedAt(surveyId) });
    }));

    server.registerTool('set_message', {
        title: 'Set system message',
        description: 'Creates or updates a system message\'s text per language (audio is kept; use set_audio to change it). Standard keys: ' +
            editing.STANDARD_MESSAGE_KEYS.join(', ') + ', and <rapid test id>_rapid_test_instruction.',
        inputSchema: {
            surveyId: z.number().int(),
            message_key: z.string(),
            text: z.record(z.string(), z.string()).describe('Message text per language. Markdown allowed.'),
            message_type: z.string().optional(),
        },
    }, handle(async ({ surveyId, message_key, text, message_type }, extra) => {
        await editing.setMessage(surveyId, message_key, { text, messageType: message_type }, mcpCtx(extra));
        const known = await editing.isKnownMessageKey(surveyId, message_key);
        return json({ message_key, updated_at: await updatedAt(surveyId),
            ...(known ? {} : { warning: `"${message_key}" is not a standard message key, so the tablet may never show it.` }) });
    }));

    const audioTarget = {
        surveyId: z.number().int(),
        target: z.enum(['question', 'option', 'message']),
        question: questionRef.optional().describe('For question and option targets'),
        option_index: z.number().int().optional().describe('For option targets: 0-based option position'),
        message_key: z.string().optional().describe('For message targets'),
        language: z.string().describe('One of the survey\'s languages'),
    };

    server.registerTool('set_audio', {
        title: 'Set audio',
        description: 'Uploads MP3 audio (base64, at most 10 MB decoded) for one question, option or message in one language. One file per call. Recorded human voice is preferred for audio self-interviews.',
        inputSchema: { ...audioTarget, mp3_base64: z.string().describe('Base64 MP3, optionally as a data:audio/mp3;base64, URL') },
    }, handle(async ({ surveyId, target, question, option_index, message_key, language, mp3_base64 }, extra) => {
        const result = await editing.setAudio(surveyId, { type: target, question, option_index, message_key },
            language, mp3_base64, mcpCtx(extra));
        const total = await editing.surveyAudioBytes(surveyId);
        return json({ ...result, survey_audio_total_mb: Math.round(total / 10485.76) / 100, updated_at: await updatedAt(surveyId) });
    }));

    server.registerTool('remove_audio', {
        title: 'Remove audio',
        description: 'Removes the audio for one question, option or message in one language.',
        inputSchema: audioTarget,
    }, handle(async ({ surveyId, target, question, option_index, message_key, language }, extra) => {
        const result = await editing.setAudio(surveyId, { type: target, question, option_index, message_key },
            language, null, mcpCtx(extra));
        return json({ ...result, updated_at: await updatedAt(surveyId) });
    }));

    // ---- lab tests ---------------------------------------------------------

    const labFields = {
        test_name: z.string().optional(),
        test_code: z.string().nullable().optional().describe('Alphanumeric code'),
        test_type: z.enum(labEditing.TEST_TYPES).optional(),
        options: z.array(z.string()).optional().describe('Dropdown choices (at least 2)'),
        min_value: z.number().nullable().optional(),
        max_value: z.number().nullable().optional(),
        unit: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
        display_order: z.number().int().optional(),
        jexl_condition: z.string().nullable().optional().describe('JEXL over survey answers; the test is offered only when true. Option answers are the option TEXT here, not the number; a rapid test result is a variable named by its test id with a lowercase value (e.g. hivrapid == "positive"). See the authoring guide.'),
    };

    server.registerTool('create_lab_test', {
        title: 'Create lab test',
        description: 'Creates a lab test. Lab tests are global: new tests are active and reach every facility\'s tablets at their next login.',
        inputSchema: { ...labFields, test_name: z.string(), test_type: z.enum(labEditing.TEST_TYPES) },
    }, handle(async (fields, extra) => {
        const result = await labEditing.createLabTest(fields, { userId: userIdFrom(extra), via: 'mcp' });
        return json({ labTestId: result.id, notes: result.notes, jexl_check: await labEditing.labConditionReport(result.id) });
    }));

    server.registerTool('update_lab_test', {
        title: 'Update lab test',
        description: 'Changes a lab test. If it already has results, test_code and test_type can\'t change and options can\'t be removed (create a new test and deactivate this one instead).',
        inputSchema: { labTestId: z.number().int(), ...labFields },
    }, handle(async ({ labTestId, ...fields }, extra) => {
        const result = await labEditing.updateLabTest(labTestId, fields, { userId: userIdFrom(extra), via: 'mcp' }, { protectResults: true });
        return json({ labTestId, is_active: result.is_active, notes: result.notes,
            jexl_check: await labEditing.labConditionReport(labTestId) });
    }));

    server.registerTool('deactivate_lab_test', {
        title: 'Deactivate lab test',
        description: 'Stops offering a lab test on tablets (from their next login). Results are kept. There is no delete.',
        inputSchema: { labTestId: z.number().int() },
    }, handle(async ({ labTestId }, extra) => {
        return json(await labEditing.setLabTestActive(labTestId, false, { userId: userIdFrom(extra), via: 'mcp' }));
    }));

    server.registerTool('reactivate_lab_test', {
        title: 'Reactivate lab test',
        description: 'Offers a deactivated lab test again, on every facility\'s tablets from their next login.',
        inputSchema: { labTestId: z.number().int() },
    }, handle(async ({ labTestId }, extra) => {
        return json(await labEditing.setLabTestActive(labTestId, true, { userId: userIdFrom(extra), via: 'mcp' }));
    }));
}

module.exports = { registerSurveyTools, _internals: { fullCheck } };
