/**
 * dataDictionary.js — generates a survey data dictionary as CSV.
 *
 * General-purpose and decoupled from any one feature: it produces one row per
 * variable that appears in the analysis export (matching the column names that
 * `dataExporter.js` emits), built from the survey questions/options/sections,
 * the survey's rapid tests, and the lab test configurations.
 *
 * Consumed by the MCP report builder (`get_data_dictionary` tool) and intended
 * for reuse by a future "Download data dictionary" button in the Export tab.
 *
 * Output columns (one row per export variable):
 *   variable      exact column name in data_wide.csv (e.g. q_age, q_risk_0,
 *                 rapid_1_result, lab_cd4, meta_facility_name)
 *   source        survey | rapid_test | lab | meta
 *   short_name    question short_name / test id / meta key
 *   label         English question / test / variable label
 *   type          categorical | numeric | text | binary | datetime
 *   section       survey section name (survey questions only)
 *   value_labels  "index=label;..." for coded variables (e.g. 0=No;1=Yes)
 *   validation    the question's validation_script, verbatim
 *   skip          the question's pre_script (display/skip logic), verbatim;
 *                 for labs, the jexl_condition, verbatim
 *   skip_to       the question's skip_to_script (+ skip_to_target), verbatim
 *   unit          measurement unit (lab tests)
 *
 * validation / skip / skip_to are the raw script strings — no interpretation is
 * applied — so the analyst reads the actual logic rather than a paraphrase.
 */

const { getAsync, allAsync } = require('../models/database');

const DICTIONARY_COLUMNS = [
    'variable', 'source', 'short_name', 'label', 'type',
    'section', 'value_labels', 'validation', 'skip', 'skip_to', 'unit'
];

/** Pick an English string out of a multilingual JSON blob, tolerating the
 *  several key conventions used across the codebase ("en", "English", ...). */
function extractEnglish(jsonText) {
    if (!jsonText) return '';
    let obj;
    try {
        obj = typeof jsonText === 'string' ? JSON.parse(jsonText) : jsonText;
    } catch {
        return String(jsonText);
    }
    if (obj == null) return '';
    if (typeof obj !== 'object') return String(obj);
    for (const key of ['en', 'En', 'EN', 'english', 'English', 'ENGLISH']) {
        if (obj[key]) return String(obj[key]);
    }
    const first = Object.values(obj).find(v => v != null && v !== '');
    return first != null ? String(first) : '';
}

/** Collapse whitespace/newlines so labels sit cleanly in one CSV cell. */
function clean(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

/** Mimic SQLite's LOWER(): ASCII A–Z only. dataExporter builds lab variable
 *  names with `REPLACE(LOWER(test_name),' ','_')`, so non-ASCII (e.g. Armenian)
 *  characters stay in their original case — JS toLowerCase() would diverge. */
function asciiLower(text) {
    return String(text == null ? '' : text).replace(/[A-Z]/g, c => c.toLowerCase());
}

/** Build "0=No;1=Yes" style value labels from an options list. */
function optionValueLabels(options) {
    return options
        .map(o => `${o.option_index}=${clean(extractEnglish(o.option_text_json))}`)
        .join(';');
}

const TYPE_MAP = {
    multiple_choice: 'categorical',
    multi_select: 'binary',     // exploded into per-option indicators
    numeric: 'numeric',
    text: 'text',
};

// Standard meta/device/coupon/payment variables emitted by dataExporter for
// every survey, regardless of question content.
const STANDARD_VARIABLES = [
    { variable: 'meta_survey_id', source: 'meta', short_name: 'survey_id', label: 'Survey response id', type: 'text' },
    { variable: 'meta_participant_id', source: 'meta', short_name: 'participant_id', label: 'Participant id', type: 'text' },
    { variable: 'meta_facility_id', source: 'meta', short_name: 'facility_id', label: 'Facility id', type: 'text' },
    { variable: 'meta_facility_name', source: 'meta', short_name: 'facility_name', label: 'Facility name', type: 'categorical' },
    { variable: 'meta_started_at', source: 'meta', short_name: 'started_at', label: 'Interview start timestamp', type: 'datetime' },
    { variable: 'meta_completed_at', source: 'meta', short_name: 'completed_at', label: 'Interview completion timestamp', type: 'datetime' },
    { variable: 'meta_language', source: 'meta', short_name: 'language', label: 'Interview language', type: 'categorical' },
    { variable: 'device_id', source: 'meta', short_name: 'device_id', label: 'Device id', type: 'text' },
    { variable: 'device_model', source: 'meta', short_name: 'device_model', label: 'Device model', type: 'categorical' },
    { variable: 'device_android_version', source: 'meta', short_name: 'android_version', label: 'Android version', type: 'categorical' },
    { variable: 'device_app_version', source: 'meta', short_name: 'app_version', label: 'App version', type: 'categorical' },
    { variable: 'coupon_referral_used', source: 'meta', short_name: 'referral_coupon', label: 'Referral coupon code used', type: 'text' },
    { variable: 'coupon_issued_count', source: 'meta', short_name: 'coupon_issued_count', label: 'Number of coupons issued', type: 'numeric' },
    { variable: 'pay_confirmed', source: 'meta', short_name: 'pay_confirmed', label: 'Payment confirmed', type: 'categorical' },
    { variable: 'pay_amount', source: 'meta', short_name: 'pay_amount', label: 'Payment amount', type: 'numeric' },
    { variable: 'pay_type', source: 'meta', short_name: 'pay_type', label: 'Payment type', type: 'categorical' },
    { variable: 'pay_date', source: 'meta', short_name: 'pay_date', label: 'Payment date', type: 'datetime' },
    { variable: 'sample_collected', source: 'meta', short_name: 'sample_collected', label: 'Biological sample collected', type: 'categorical' },
];

function emptyRow() {
    const r = {};
    for (const c of DICTIONARY_COLUMNS) r[c] = '';
    return r;
}

/**
 * Build the dictionary as an array of plain row objects (keys = DICTIONARY_COLUMNS).
 * @param {number} surveyId
 */
async function buildDictionaryRows(surveyId) {
    const rows = [];
    const push = (partial) => rows.push({ ...emptyRow(), ...partial });

    const survey = await getAsync('SELECT id, name, version FROM surveys WHERE id = ?', [surveyId]);
    if (!survey) {
        const err = new Error(`Survey ${surveyId} not found`);
        err.code = 'SURVEY_NOT_FOUND';
        throw err;
    }

    // Sections (id -> name) for labelling.
    const sections = await allAsync('SELECT id, name FROM sections WHERE survey_id = ?', [surveyId]);
    const sectionName = new Map(sections.map(s => [s.id, s.name]));

    // Survey questions, in order.
    const questions = await allAsync(
        `SELECT id, short_name, question_type, question_text_json, pre_script,
                validation_script, skip_to_script, skip_to_target, section_id, question_index
         FROM questions WHERE survey_id = ? AND short_name IS NOT NULL
         ORDER BY question_index`,
        [surveyId]
    );

    for (const q of questions) {
        const options = await allAsync(
            'SELECT option_index, option_text_json FROM options WHERE question_id = ? ORDER BY option_index',
            [q.id]
        );
        const label = clean(extractEnglish(q.question_text_json));
        const section = q.section_id ? clean(sectionName.get(q.section_id) || '') : '';
        const type = TYPE_MAP[q.question_type] || 'text';
        // Raw scripts, verbatim (no paraphrasing of the logic).
        const validation = clean(q.validation_script);
        const skip = clean(q.pre_script);
        const skip_to = q.skip_to_script
            ? clean(q.skip_to_script) + (q.skip_to_target ? ` -> ${clean(q.skip_to_target)}` : '')
            : (q.skip_to_target ? `-> ${clean(q.skip_to_target)}` : '');

        if (q.question_type === 'multi_select') {
            // dataExporter explodes multi_select into one 0/1 indicator per option.
            for (const o of options) {
                push({
                    variable: `q_${q.short_name}_${o.option_index}`,
                    source: 'survey', short_name: q.short_name,
                    label: `${label} — ${clean(extractEnglish(o.option_text_json))}`,
                    type: 'binary', section, value_labels: '0=Not selected;1=Selected', validation, skip, skip_to,
                });
            }
            if (options.length === 0) {
                push({ variable: `q_${q.short_name}`, source: 'survey', short_name: q.short_name, label, type: 'binary', section, validation, skip, skip_to });
            }
        } else {
            push({
                variable: `q_${q.short_name}`,
                source: 'survey', short_name: q.short_name, label, type, section,
                value_labels: q.question_type === 'multiple_choice' ? optionValueLabels(options) : '',
                validation, skip, skip_to,
            });
        }
    }

    // Rapid tests for this survey.
    const rapidTests = await allAsync(
        'SELECT test_id, test_name, enabled FROM test_configurations WHERE survey_id = ? ORDER BY display_order',
        [surveyId]
    );
    for (const t of rapidTests) {
        push({
            variable: `rapid_${t.test_id}_result`,
            source: 'rapid_test', short_name: t.test_id,
            label: `${clean(t.test_name)} (rapid test result)${t.enabled ? '' : ' [not enabled]'}`,
            type: 'categorical',
        });
    }

    // Lab tests (global configuration; labs join on participant id at export).
    const labTests = await allAsync(
        `SELECT test_name, test_type, options, min_value, max_value, unit, jexl_condition
         FROM lab_test_configurations WHERE is_active = 1 ORDER BY display_order`,
        []
    );
    for (const l of labTests) {
        const variable = `lab_${asciiLower(l.test_name).replace(/ /g, '_')}`;
        let valueLabels = '';
        if (l.test_type === 'dropdown' && l.options) {
            try {
                const opts = JSON.parse(l.options);
                if (Array.isArray(opts)) {
                    valueLabels = opts.map((o, i) => `${i}=${clean(typeof o === 'string' ? o : (o.label || o.value || ''))}`).join(';');
                }
            } catch { /* leave blank */ }
        }
        push({
            variable, source: 'lab', short_name: clean(l.test_name),
            label: clean(l.test_name),
            type: l.test_type === 'numeric' ? 'numeric' : 'categorical',
            value_labels: valueLabels,
            unit: clean(l.unit),
            skip: l.jexl_condition ? clean(l.jexl_condition) : '',   // raw applicability condition
        });
    }

    // Standard meta/device/coupon/payment variables.
    for (const v of STANDARD_VARIABLES) push(v);

    return { survey, rows };
}

/** Minimal RFC-4180 CSV cell escaping. */
const { neutralizeFormula } = require('./csvSafety');

function csvCell(value, forSpreadsheet = false) {
    const s = value == null ? '' : (forSpreadsheet ? neutralizeFormula(value) : String(value));
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowsToCsv(rows, { forSpreadsheet = false } = {}) {
    const lines = [DICTIONARY_COLUMNS.join(',')];
    for (const r of rows) lines.push(DICTIONARY_COLUMNS.map(c => csvCell(r[c], forSpreadsheet)).join(','));
    return lines.join('\n') + '\n';
}

/**
 * Generate the data dictionary CSV string for a survey.
 * @param {number} surveyId
 * @returns {Promise<string>} CSV text
 */
async function generateDictionaryCsv(surveyId, { forSpreadsheet = false } = {}) {
    const { rows } = await buildDictionaryRows(surveyId);
    return rowsToCsv(rows, { forSpreadsheet });
}

module.exports = {
    DICTIONARY_COLUMNS,
    buildDictionaryRows,
    generateDictionaryCsv,
    rowsToCsv,
    extractEnglish,
};
