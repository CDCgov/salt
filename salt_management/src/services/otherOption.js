/**
 * Rules for "other, specify" options (options.is_other).
 *
 * A multiple_choice or multi_select question may mark one option as "other".
 * When a participant selects it the tablet shows a free-text box; the text is
 * stored in survey_responses.response_other_text and exposed to JEXL as the
 * derived variable `<short_name>_other`. That derived name is reserved, so no
 * other question in the same survey may use it as its short_name.
 */

const OTHER_QUESTION_TYPES = new Set(['multiple_choice', 'multi_select']);
const OTHER_SUFFIX = '_other';

function isOtherFlag(v) {
    return v === true || v === 1 || v === '1' || v === 'true';
}

/**
 * Checks a question's options. Returns an error message, or null when valid.
 * `options` items carry `is_other` (any truthy form accepted by isOtherFlag).
 */
function validateOtherOptions(questionType, options) {
    const count = (options || []).filter(o => isOtherFlag(o.is_other)).length;
    if (count === 0) return null;
    if (!OTHER_QUESTION_TYPES.has(questionType)) {
        return 'Only multiple choice and multi-select questions can have an "other" option';
    }
    if (count > 1) return 'A question can have at most one "other" option';
    return null;
}

/**
 * Checks the reserved `<short_name>_other` names within one survey.
 * `question` is { short_name, has_other }; `others` are the survey's other
 * questions in the same shape. Returns an error message, or null.
 */
function otherNameClash(question, others) {
    for (const q of others) {
        if (question.has_other && q.short_name === question.short_name + OTHER_SUFFIX) {
            return `"${q.short_name}" is already a question short name, so "${question.short_name}" `
                + `cannot have an "other" option (its text is stored as ${question.short_name}${OTHER_SUFFIX})`;
        }
        if (q.has_other && question.short_name === q.short_name + OTHER_SUFFIX) {
            return `"${question.short_name}" is reserved for the "other" text of question "${q.short_name}"`;
        }
    }
    return null;
}

module.exports = { OTHER_QUESTION_TYPES, OTHER_SUFFIX, isOtherFlag, validateOtherOptions, otherNameClash };
