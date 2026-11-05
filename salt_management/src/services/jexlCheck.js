/**
 * Checks a survey's JEXL scripts before they reach tablets.
 *
 * Each script is parsed by the tablet's own JEXL library (see jexlParser.js),
 * which returns syntax errors and the variable names the script uses. The
 * survey rules below then check those names against the survey: unknown
 * names, questions asked later, multi-select comparisons, option numbers,
 * skip-to targets and missing translations.
 *
 * Variables match what the tablet puts in each script's context
 * (salt_android SurveyViewModel.buildJexlContext and LabTestJexlEvaluator):
 *   - every question's short_name (later questions are present but blank)
 *   - <short_name>_other for questions with an "other" option
 *   - `value` in validation and skip-to scripts (the current answer)
 *   - `facility_coupons` in the coupon count script
 *   - lab test conditions: answered questions' short_names and rapid test ids
 * Multiple choice answers are the 0-based option number, multi-select answers
 * are a list of option numbers. In lab test conditions a multiple choice
 * answer is the option's text instead.
 *
 * Result: { errors: Issue[], warnings: Issue[], checked: boolean }
 *   Issue = { level, key, field, question_id, short_name, message }
 * Errors block activation; saves are allowed with errors.
 */

const { parseScripts, unavailableMessage } = require('./jexlParser');
const { isOtherFlag, OTHER_SUFFIX } = require('./otherOption');

const ALLOWED_CALLS = new Set(['.contains', '.size', 'size', 'empty']);
const ALLOWED_CALLS_TEXT = '=~, .contains(), .size(), size() and empty()';

const QUESTION_FIELDS = ['pre_script', 'validation_script', 'skip_to_script'];
const FIELD_LABELS = {
    pre_script: 'Skip logic',
    validation_script: 'Validation',
    skip_to_script: 'Skip-to condition',
    skip_to_target: 'Skip-to target',
    eligibility_script: 'Eligibility script',
    coupon_count_script: 'Coupon count script',
    jexl_condition: 'Lab test condition',
    text: 'Translations'
};

// ---------------------------------------------------------------------------
// Survey model

function parseJson(text, fallback) {
    if (text == null || text === '') return fallback;
    if (typeof text === 'object') return text;
    try { return JSON.parse(text); } catch (_) { return fallback; }
}

/**
 * Builds the lookup structures the rules need. Accepts DB rows or an export
 * bundle (same column names).
 */
function buildModel({ survey = {}, sections = [], questions = [], options = [], testIds = [] }) {
    const sectionType = new Map(sections.map(s => [s.id, s.section_type]));
    const ordered = [...questions].sort((a, b) =>
        (a.question_index ?? 0) - (b.question_index ?? 0) || (a.id ?? 0) - (b.id ?? 0));
    const optionsByQuestion = new Map();
    for (const o of options) {
        if (!optionsByQuestion.has(o.question_id)) optionsByQuestion.set(o.question_id, []);
        optionsByQuestion.get(o.question_id).push(o);
    }
    const byName = new Map();
    const otherByName = new Map();
    ordered.forEach((q, position) => {
        const opts = optionsByQuestion.get(q.id) || [];
        const info = {
            q, position,
            type: q.question_type,
            optionCount: opts.length,
            hasOther: opts.some(o => isOtherFlag(o.is_other)),
            eligibility: sectionType.get(q.section_id) === 'eligibility',
            options: opts
        };
        if (q.short_name) byName.set(q.short_name, info);
    });
    for (const info of byName.values()) {
        if (info.hasOther) otherByName.set(info.q.short_name + OTHER_SUFFIX, info);
    }

    // Questions that may be blank when a later script reads them: they have
    // their own skip logic, or a skip-to jump can pass over them.
    const mayBeSkipped = new Set();
    for (const info of byName.values()) {
        if (info.q.pre_script && info.q.pre_script.trim()) mayBeSkipped.add(info.q.short_name);
    }
    for (const info of byName.values()) {
        const target = byName.get(info.q.skip_to_target);
        if (!info.q.skip_to_script || !info.q.skip_to_script.trim() || !target) continue;
        for (const other of byName.values()) {
            if (other.position > info.position && other.position < target.position) {
                mayBeSkipped.add(other.q.short_name);
            }
        }
    }

    return {
        survey, ordered, byName, otherByName, mayBeSkipped,
        testIds: new Set(testIds.filter(Boolean)),
        languages: (parseJson(survey.languages, []) || []).filter(l => typeof l === 'string' && l)
    };
}

// ---------------------------------------------------------------------------
// Source scanning (strings blanked so their contents are never matched)

function blankStrings(src) {
    let out = '';
    let quote = null;
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (quote) {
            if (c === '\\' && i + 1 < src.length) { out += '  '; i++; continue; }
            if (c === quote) { quote = null; out += c; continue; }
            out += ' ';
        } else {
            if (c === '\'' || c === '"' || c === '`') quote = c;
            out += c;
        }
    }
    return out;
}

const NUM = '-?\\d+(?:\\.\\d+)?';
const NAME = '[A-Za-z_$][\\w$]*';

/** Comparisons of a variable with a number or list literal. */
function literalComparisons(code) {
    const found = [];
    const forward = new RegExp(`(?<![\\w.$])(${NAME})\\s*(==|!=|<=|>=|=~|!~|<|>)\\s*(\\[[^\\]]*\\]|${NUM})`, 'g');
    for (const m of code.matchAll(forward)) found.push({ name: m[1], op: m[2], literal: m[3], reversed: false });
    const reverse = new RegExp(`(${NUM})\\s*(==|!=|<=|>=|=~|!~|<|>)\\s*(${NAME})(?![\\w$(.])`, 'g');
    for (const m of code.matchAll(reverse)) {
        const flip = { '<': '>', '>': '<', '<=': '>=', '>=': '<=' }[m[2]] || m[2];
        found.push({ name: m[3], op: flip, literal: m[1], reversed: true });
    }
    return found;
}

/** Variables used on either side of <, >, <=, >=. */
function relationalOperands(code) {
    const names = new Set();
    const left = new RegExp(`(?<![\\w.$])(${NAME})\\s*(?:<=|>=|<(?!=)|>(?!=))`, 'g');
    for (const m of code.matchAll(left)) names.add(m[1]);
    const right = new RegExp(`(?:<=|>=|(?<![=!<>])<|(?<![=\\-])>)\\s*(${NAME})(?![\\w$(.])`, 'g');
    for (const m of code.matchAll(right)) names.add(m[1]);
    return names;
}

/** True when the script tests `name` against null (x != null, x == null, empty(x)). */
function hasNullGuard(code, name) {
    const n = name.replace(/\$/g, '\\$');
    return new RegExp(`(?<![\\w.$])${n}\\s*[!=]=\\s*null\\b|\\bnull\\s*[!=]=\\s*${n}(?![\\w$])|\\bempty\\s*\\(\\s*${n}\\s*\\)`).test(code);
}

/** `name.contains(<number>)` calls. */
function containsCalls(code) {
    const re = new RegExp(`(?<![\\w.$])(${NAME})\\s*\\.\\s*contains\\s*\\(\\s*(${NUM})?`, 'g');
    return [...code.matchAll(re)].map(m => ({ name: m[1], literal: m[2] }));
}

function listNumbers(literal) {
    if (!literal.startsWith('[')) return [Number(literal)];
    return literal.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean)
        .map(Number).filter(n => !Number.isNaN(n));
}

// ---------------------------------------------------------------------------
// Rules

function levenshtein(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1,
                d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
    }
    return d[a.length][b.length];
}

function suggestName(name, known) {
    let best = null;
    let bestScore = Infinity;
    for (const k of known) {
        const score = k.toLowerCase() === name.toLowerCase() ? 0 : levenshtein(name.toLowerCase(), k.toLowerCase());
        if (score < bestScore) { best = k; bestScore = score; }
    }
    const limit = Math.max(1, Math.min(2, Math.floor(name.length / 3)));
    return bestScore <= limit ? best : null;
}

/**
 * Describes where a script runs.
 * kind: 'question' | 'eligibility' | 'coupon' | 'lab'
 * field: column name; owner: the question's model info (question scripts)
 */
function scriptContext(model, kind, field, owner) {
    const hasValue = kind === 'question' && field !== 'pre_script';
    const extra = new Set();
    if (hasValue) extra.add('value');
    if (kind === 'coupon') extra.add('facility_coupons');
    return { kind, field, owner, hasValue, extra };
}

function resolveName(model, ctx, name) {
    if (name === 'value' && ctx.hasValue) return { info: ctx.owner, isValue: true };
    if (model.byName.has(name)) return { info: model.byName.get(name) };
    if (ctx.kind !== 'lab' && model.otherByName.has(name)) return { info: model.otherByName.get(name), isOther: true };
    return null;
}

function knownNames(model, ctx) {
    const names = [...model.byName.keys(), ...ctx.extra];
    if (ctx.kind !== 'lab') names.push(...model.otherByName.keys());
    if (ctx.kind === 'lab') names.push(...model.testIds);
    return names;
}

/** True when `info` has no answer yet when this script runs. */
function askedLater(ctx, info) {
    if (ctx.kind === 'eligibility') return !info.eligibility;
    if (ctx.kind !== 'question') return false;
    if (ctx.field === 'pre_script') return info.position >= ctx.owner.position;
    return info.position > ctx.owner.position;
}

function laterMessage(ctx, name, info) {
    if (ctx.kind === 'eligibility') {
        return `"${name}" is asked after the eligibility check, so it has no answer yet when this script runs.`;
    }
    if (info === ctx.owner) {
        return `Skip logic uses the question's own answer ("${name}"), which isn't set yet when the skip logic runs.`;
    }
    return `"${name}" is asked later in the survey, so it has no answer yet when this script runs.`;
}

function applyRules(model, ctx, src, parsed, add) {
    const code = blankStrings(src);

    for (const call of parsed.calls || []) {
        if (!ALLOWED_CALLS.has(call)) {
            add('error', `${call}() is not allowed. Use ${ALLOWED_CALLS_TEXT}.`);
        }
    }

    const resolved = new Map();
    for (const name of parsed.vars || []) {
        if (name === 'value' && !ctx.hasValue && ctx.kind !== 'lab') {
            add('error', `"value" is only set in validation and skip-to scripts. Use the question's short name here.`);
            continue;
        }
        if (ctx.extra.has(name) || (ctx.kind === 'lab' && model.testIds.has(name))) continue;
        const r = resolveName(model, ctx, name);
        if (!r) {
            const hint = suggestName(name, knownNames(model, ctx));
            const what = ctx.kind === 'lab' ? 'no question or rapid test in the active survey has that name' : 'no question has that short name';
            add('error', `Unknown variable "${name}": ${what}.${hint ? ` Did you mean "${hint}"?` : ''}`);
            continue;
        }
        resolved.set(name, r);
        if (!r.isValue && askedLater(ctx, r.info)) add('warning', laterMessage(ctx, name, r.info));
    }

    // Comparisons with numbers and lists
    for (const cmp of literalComparisons(code)) {
        const r = resolved.get(cmp.name);
        if (!r) continue;
        const { info } = r;
        if (r.isOther) {
            if (['<', '>', '<=', '>='].includes(cmp.op)) {
                add('warning', `"${cmp.name}" is the "other" text, so ${cmp.op} compares text, not numbers.`);
            }
            continue;
        }
        if (ctx.kind === 'lab' && info.type === 'multiple_choice' && (cmp.op === '==' || cmp.op === '!=')
            && !cmp.literal.startsWith('[')) {
            add('warning', `In lab test conditions a multiple choice answer is the option's text, not its number, so "${cmp.name} ${cmp.op} ${cmp.literal}" never matches. Compare with the option text in quotes.`);
            continue;
        }
        if (info.type === 'multi_select' && (cmp.op === '==' || cmp.op === '!=') && !cmp.literal.startsWith('[')) {
            add('warning', `"${cmp.name}" is a multi-select question, so its answer is a list. Use "${cmp.literal} =~ ${cmp.name}" or "${cmp.name}.contains(${cmp.literal})" instead of ${cmp.op}.`);
            continue;
        }
        if (info.type === 'multi_select' && !cmp.reversed && (cmp.op === '=~' || cmp.op === '!~') && cmp.literal.startsWith('[')) {
            add('warning', `"${cmp.name} ${cmp.op} ${cmp.literal}" tests whether every ticked option is in the list, and is true when nothing is ticked. To test one option, use "N =~ ${cmp.name}" or "${cmp.name}.contains(N)".`);
        }
        const membership = cmp.op === '==' || cmp.op === '!=' || cmp.op === '=~' || cmp.op === '!~';
        if (ctx.kind !== 'lab' && membership && (info.type === 'multiple_choice' || info.type === 'multi_select')) {
            const bad = listNumbers(cmp.literal).filter(n => !Number.isInteger(n) || n < 0 || n >= info.optionCount);
            if (bad.length) {
                add('warning', `"${cmp.name}" has ${info.optionCount} options, numbered 0 to ${info.optionCount - 1}, so ${bad.join(', ')} never matches.`);
            }
        }
    }

    for (const call of containsCalls(code)) {
        const r = resolved.get(call.name);
        if (!r || r.isOther) continue;
        if (r.info.type !== 'multi_select') {
            add('warning', `"${call.name}" is not a multi-select question, so .contains() returns nothing and the script fails. Use == instead.`);
        } else if (call.literal != null) {
            const n = Number(call.literal);
            if (!Number.isInteger(n) || n < 0 || n >= r.info.optionCount) {
                add('warning', `"${call.name}" has ${r.info.optionCount} options, numbered 0 to ${r.info.optionCount - 1}, so ${call.literal} never matches.`);
            }
        }
    }

    // <, > on an answer that may be blank: strict JEXL errors on a blank.
    if (ctx.kind !== 'lab') {
        for (const name of relationalOperands(code)) {
            const r = resolved.get(name);
            if (!r || r.isValue || r.isOther) continue;
            if (askedLater(ctx, r.info)) continue;
            // A validation or skip-to script's own question is always answered.
            if (ctx.hasValue && r.info === ctx.owner) continue;
            if (model.mayBeSkipped.has(r.info.q.short_name) && !hasNullGuard(code, name)) {
                add('warning', `"${name}" may have been skipped. Comparing a skipped (blank) answer with <, >, <= or >= is an error on the tablet. Check it first, for example "${name} != null && ...".`);
            }
        }
    }
}

function parseErrorMessage(r) {
    const where = r.line ? ` (line ${r.line}, column ${r.col})` : '';
    if (/assign/i.test(r.error || '')) {
        return `Assignment (=) is not allowed. Use == to compare.${where}`;
    }
    return `Syntax error: ${r.error}${where}`;
}

// ---------------------------------------------------------------------------
// Entry points

function makeCollector() {
    const errors = [];
    const warnings = [];
    const seen = new Set();
    // extra: { key, label, lab_test_id } overrides for lab test conditions
    function issue(level, field, info, message, extra = {}) {
        const shortName = info ? info.q.short_name : null;
        const key = extra.key || `${shortName || 'survey'}.${field}`;
        const dedupe = `${level}|${key}|${message}`;
        if (seen.has(dedupe)) return;
        seen.add(dedupe);
        const label = extra.label || `${FIELD_LABELS[field] || field}${shortName ? ` (${shortName})` : ''}`;
        const item = {
            level, key, field,
            question_id: info ? info.q.id ?? null : null,
            short_name: shortName,
            message: `${label}: ${message}`
        };
        if (extra.lab_test_id !== undefined) item.lab_test_id = extra.lab_test_id;
        (level === 'error' ? errors : warnings).push(item);
    }
    return { errors, warnings, issue };
}

function surveyScripts(model) {
    const scripts = [];
    for (const info of model.byName.values()) {
        for (const field of QUESTION_FIELDS) {
            const src = info.q[field];
            if (src && String(src).trim()) {
                scripts.push({ field, info, src: String(src), ctx: scriptContext(model, 'question', field, info) });
            }
        }
    }
    for (const [field, kind] of [['eligibility_script', 'eligibility'], ['coupon_count_script', 'coupon']]) {
        const src = model.survey[field];
        if (src && String(src).trim()) {
            scripts.push({ field, info: null, src: String(src), ctx: scriptContext(model, kind, field, null) });
        }
    }
    return scripts;
}

async function runScripts(model, scripts, collector) {
    const keyed = scripts.map((s, i) => ({ ...s, key: `s${i}` }));
    const parsed = await parseScripts(keyed.map(s => ({ key: s.key, src: s.src })));
    if (!parsed) {
        collector.issue('warning', 'checker', null,
            `Scripts were not checked because the JEXL checker is unavailable (${unavailableMessage()}).`);
        return false;
    }
    for (const s of keyed) {
        const r = parsed.get(s.key);
        if (!r) continue;
        const add = (level, message) => collector.issue(level, s.field, s.info, message);
        if (!r.ok) add('error', parseErrorMessage(r));
        else applyRules(model, s.ctx, s.src, r, add);
    }
    return true;
}

function checkSkipTargets(model, collector) {
    for (const info of model.byName.values()) {
        const script = info.q.skip_to_script && String(info.q.skip_to_script).trim();
        const target = info.q.skip_to_target && String(info.q.skip_to_target).trim();
        if (!script) continue;
        const add = message => collector.issue('error', 'skip_to_target', info, message);
        if (!target) { add('The skip-to condition has no target question.'); continue; }
        const t = model.byName.get(target);
        if (!t) { add(`Target "${target}" is not a question in this survey.`); continue; }
        if (t.position <= info.position) add(`Target "${target}" must come after this question.`);
    }
}

function missingLanguages(model, json) {
    const texts = parseJson(json, {}) || {};
    return model.languages.filter(l => typeof texts[l] !== 'string' || !texts[l].trim());
}

function checkTranslations(model, collector) {
    if (!model.languages.length) return;
    for (const info of model.byName.values()) {
        const parts = [];
        const qMissing = missingLanguages(model, info.q.question_text_json);
        if (qMissing.length) parts.push(`question text missing in ${qMissing.join(', ')}`);
        const optMissing = new Set();
        const optNumbers = [];
        for (const o of info.options) {
            const m = missingLanguages(model, o.option_text_json);
            if (m.length) { m.forEach(l => optMissing.add(l)); optNumbers.push(o.option_index); }
        }
        if (optNumbers.length) {
            parts.push(`option ${optNumbers.join(', ')} text missing in ${[...optMissing].join(', ')}`);
        }
        if (parts.length) collector.issue('warning', 'text', info, `${parts.join('; ')}.`);
    }
}

function result(collector, checked) {
    return { errors: collector.errors, warnings: collector.warnings, checked };
}

/**
 * Full survey check.
 * @param {object} data  { survey, sections, questions, options, testIds }
 */
async function checkSurveyData(data) {
    const model = buildModel(data);
    const collector = makeCollector();
    const checked = await runScripts(model, surveyScripts(model), collector);
    checkSkipTargets(model, collector);
    checkTranslations(model, collector);
    // A blank eligibility script lets everyone through; usually an oversight.
    if (!String(model.survey.eligibility_script || '').trim()) {
        collector.issue('warning', 'eligibility_script', null,
            'There is no eligibility script, so every participant is eligible. Add one unless that is intended.');
    }
    return result(collector, checked);
}

/** Loads a survey from the database in the shape checkSurveyData expects. */
async function loadSurveyData(db, surveyId) {
    const survey = await db.getAsync('SELECT * FROM surveys WHERE id = ?', [surveyId]);
    if (!survey) return null;
    const [sections, questions, options, tests] = await Promise.all([
        db.allAsync('SELECT * FROM sections WHERE survey_id = ?', [surveyId]),
        db.allAsync('SELECT * FROM questions WHERE survey_id = ?', [surveyId]),
        db.allAsync(`SELECT o.* FROM options o JOIN questions q ON q.id = o.question_id
                     WHERE q.survey_id = ? ORDER BY o.question_id, o.option_index`, [surveyId]),
        db.allAsync('SELECT test_id FROM test_configurations WHERE survey_id = ?', [surveyId])
    ]);
    return { survey, sections, questions, options, testIds: tests.map(t => t.test_id) };
}

async function checkSurvey(db, surveyId) {
    const data = await loadSurveyData(db, surveyId);
    return data ? checkSurveyData(data) : null;
}

/** Issues for one question (by id) or for survey-level fields. */
function filterIssues(res, { questionId = null, fields = null } = {}) {
    const keep = i => (questionId == null ? i.question_id == null : i.question_id === questionId)
        && (!fields || fields.includes(i.field) || i.field === 'checker');
    return { errors: res.errors.filter(keep), warnings: res.warnings.filter(keep), checked: res.checked };
}

/**
 * Checks lab test conditions against a survey (normally the active one).
 * @param {{id?, test_name, jexl_condition}[]} labTests
 * @param {object|null} data  survey data, or null when no survey is active
 */
async function checkLabConditions(labTests, data) {
    const model = buildModel(data || {});
    const collector = makeCollector();
    const scripts = [];
    for (const lab of labTests) {
        const src = lab.jexl_condition && String(lab.jexl_condition).trim();
        if (!src || src === 'null') continue;
        scripts.push({ lab, src, field: 'jexl_condition', ctx: scriptContext(model, 'lab', 'jexl_condition', null) });
    }
    const keyed = scripts.map((s, i) => ({ ...s, key: `l${i}` }));
    const parsed = await parseScripts(keyed.map(s => ({ key: s.key, src: s.src })));
    if (!parsed) {
        collector.issue('warning', 'checker', null,
            `Lab test conditions were not checked because the JEXL checker is unavailable (${unavailableMessage()}).`);
        return result(collector, false);
    }
    for (const s of keyed) {
        const r = parsed.get(s.key);
        if (!r) continue;
        const add = (level, message) => collector.issue(level, 'jexl_condition', null, message, {
            key: `lab:${s.lab.test_name}.jexl_condition`,
            label: `Lab test condition (${s.lab.test_name})`,
            lab_test_id: s.lab.id ?? null
        });
        if (!r.ok) add('error', parseErrorMessage(r));
        else if (data) applyRules(model, s.ctx, s.src, r, add);
    }
    return result(collector, true);
}

module.exports = {
    checkSurveyData,
    checkSurvey,
    loadSurveyData,
    filterIssues,
    checkLabConditions,
    ALLOWED_CALLS_TEXT,
    // exported for tests
    _internal: { blankStrings, literalComparisons, relationalOperands, containsCalls, suggestName }
};
