/**
 * Subject Management API
 *
 * Admin actions on completed_surveys + survey_responses for the Edit Data
 * page. Three endpoints:
 *   POST   /api/admin/subjects/:id/delete         — soft-delete (sets deleted_at)
 *   POST   /api/admin/subjects/:id/restore        — clears deleted_at
 *   PUT    /api/admin/subjects/:id/responses/:shortName
 *                                                 — edit one response value
 *
 * Every action writes an audit_log row (and the on-disk JSONL backup) via
 * auditService.logAudit. Only the analytic exports (dataExporter) honor the
 * deleted flag; operational tables stay unfiltered.
 *
 * Validation on edits is structural only — type, option-index range,
 * multi-select min/max. JEXL `validation_script` is not evaluated server-side
 * (no JEXL runtime here; the tablet enforces those rules at capture time).
 */
const express = require('express');
const { getAsync, allAsync, runAsync } = require('../../models/database');
const { requireAdmin } = require('../../middleware/auth');
const { logAudit } = require('../../services/auditService');
const router = express.Router();

async function loadSubject(completedSurveyId) {
    return await getAsync(
        `SELECT id, survey_response_id, participant_id, survey_id, facility_id,
                deleted_at, deleted_by
         FROM completed_surveys WHERE id = ?`,
        [completedSurveyId]
    );
}

router.post('/admin/subjects/:id/delete', requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id)) {
            return res.status(400).json({ status: 'error', message: 'Invalid subject id' });
        }
        const subject = await loadSubject(id);
        if (!subject) {
            return res.status(404).json({ status: 'error', message: 'Subject not found' });
        }
        if (subject.deleted_at) {
            return res.json({ status: 'success', message: 'Already deleted', alreadyDeleted: true });
        }
        const userId = req.user.id;
        await runAsync(
            `UPDATE completed_surveys
             SET deleted_at = datetime('now'), deleted_by = ?
             WHERE id = ?`,
            [userId, id]
        );
        await logAudit(
            userId,
            'DELETE_SUBJECT',
            'completed_survey',
            String(id),
            { deleted_at: null, deleted_by: null },
            { deleted_at: new Date().toISOString(), deleted_by: userId }
        );
        res.json({ status: 'success' });
    } catch (err) {
        console.error('Delete subject error:', err);
        res.status(500).json({ status: 'error', message: 'Failed to delete subject' });
    }
});

router.post('/admin/subjects/:id/restore', requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id)) {
            return res.status(400).json({ status: 'error', message: 'Invalid subject id' });
        }
        const subject = await loadSubject(id);
        if (!subject) {
            return res.status(404).json({ status: 'error', message: 'Subject not found' });
        }
        if (!subject.deleted_at) {
            return res.json({ status: 'success', message: 'Not deleted', alreadyActive: true });
        }
        const userId = req.user.id;
        const previous = { deleted_at: subject.deleted_at, deleted_by: subject.deleted_by };
        await runAsync(
            `UPDATE completed_surveys
             SET deleted_at = NULL, deleted_by = NULL
             WHERE id = ?`,
            [id]
        );
        await logAudit(
            userId,
            'RESTORE_SUBJECT',
            'completed_survey',
            String(id),
            previous,
            { deleted_at: null, deleted_by: null }
        );
        res.json({ status: 'success' });
    } catch (err) {
        console.error('Restore subject error:', err);
        res.status(500).json({ status: 'error', message: 'Failed to restore subject' });
    }
});

/**
 * Edit a single survey_responses row.
 *
 * Body shape (varies by answer_type):
 *   numeric        : { value: <number-like string or number> }
 *   text           : { value: <string> }
 *   multiple_choice: { optionIndex: <int>, otherText?: <string> }
 *   multi_select   : { optionIndices: <int[]>, otherText?: <string> }   // sent as array of ints
 *
 * otherText is the free text for the question's "other" option. It is kept
 * only while that option is selected; blank clears it. Omitted = unchanged.
 */
router.put('/admin/subjects/:id/responses/:shortName', requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const shortName = req.params.shortName;
        if (!Number.isInteger(id) || !shortName) {
            return res.status(400).json({ status: 'error', message: 'Invalid params' });
        }

        const subject = await loadSubject(id);
        if (!subject) {
            return res.status(404).json({ status: 'error', message: 'Subject not found' });
        }

        const responseRow = await getAsync(
            `SELECT id, completed_survey_id, question_id, question_index,
                    question_short_name, response_value, response_option_index,
                    response_option_text, response_multi_indices, answer_type,
                    response_other_text
             FROM survey_responses
             WHERE completed_survey_id = ? AND question_short_name = ?`,
            [id, shortName]
        );
        if (!responseRow) {
            return res.status(404).json({ status: 'error', message: 'Response not found for that question' });
        }

        // Question metadata: look up the question this response refers to,
        // scoped to the subject's survey so we pick the right options list.
        const question = await getAsync(
            `SELECT id, question_type, min_selections, max_selections
             FROM questions
             WHERE survey_id = ? AND short_name = ?`,
            [subject.survey_id, shortName]
        );
        if (!question) {
            return res.status(404).json({ status: 'error', message: 'Question definition not found' });
        }

        const optionRows = await allAsync(
            `SELECT option_index, option_text_json, is_other
             FROM options
             WHERE question_id = ? ORDER BY option_index`,
            [question.id]
        );
        const optionMap = new Map(optionRows.map(o => [o.option_index, o]));

        const oldSnapshot = { ...responseRow };
        const updates = {
            response_value: responseRow.response_value,
            response_option_index: responseRow.response_option_index,
            response_option_text: responseRow.response_option_text,
            response_multi_indices: responseRow.response_multi_indices,
            response_other_text: null
        };

        // --- Validate + project the new value into the right column(s).
        const t = question.question_type;
        const body = req.body || {};
        if (t === 'numeric') {
            const raw = body.value;
            if (raw === undefined || raw === null || String(raw).trim() === '') {
                return res.status(400).json({ status: 'error', message: 'Numeric value required' });
            }
            const n = Number(raw);
            if (!Number.isFinite(n)) {
                return res.status(400).json({ status: 'error', message: 'Value is not a number' });
            }
            updates.response_value = String(n);
            updates.response_option_index = null;
            updates.response_option_text = null;
            updates.response_multi_indices = null;
        } else if (t === 'text') {
            const raw = body.value;
            if (typeof raw !== 'string') {
                return res.status(400).json({ status: 'error', message: 'Text value required' });
            }
            updates.response_value = raw;
            updates.response_option_index = null;
            updates.response_option_text = null;
            updates.response_multi_indices = null;
        } else if (t === 'multiple_choice') {
            const idx = Number(body.optionIndex);
            if (!Number.isInteger(idx) || !optionMap.has(idx)) {
                return res.status(400).json({ status: 'error', message: 'optionIndex must be a valid option index' });
            }
            const opt = optionMap.get(idx);
            let optionText = '';
            try {
                const parsed = JSON.parse(opt.option_text_json || '{}');
                optionText = parsed.en || Object.values(parsed)[0] || '';
            } catch (e) {
                optionText = opt.option_text_json || '';
            }
            updates.response_value = null;
            updates.response_option_index = idx;
            updates.response_option_text = optionText;
            updates.response_multi_indices = null;
        } else if (t === 'multi_select') {
            const arr = body.optionIndices;
            if (!Array.isArray(arr)) {
                return res.status(400).json({ status: 'error', message: 'optionIndices must be an array' });
            }
            const ints = arr.map(x => Number(x));
            if (ints.some(x => !Number.isInteger(x) || !optionMap.has(x))) {
                return res.status(400).json({ status: 'error', message: 'All optionIndices must be valid option indices' });
            }
            const unique = Array.from(new Set(ints)).sort((a, b) => a - b);
            if (Number.isInteger(question.min_selections) && unique.length < question.min_selections) {
                return res.status(400).json({ status: 'error', message: `At least ${question.min_selections} selections required` });
            }
            if (Number.isInteger(question.max_selections) && unique.length > question.max_selections) {
                return res.status(400).json({ status: 'error', message: `At most ${question.max_selections} selections allowed` });
            }
            updates.response_value = null;
            updates.response_option_index = null;
            updates.response_option_text = null;
            updates.response_multi_indices = unique.join(',');
        } else {
            return res.status(400).json({ status: 'error', message: `Editing answer_type "${t}" is not supported` });
        }

        // "Other" free text survives only while the other option is selected.
        const otherOption = optionRows.find(o => o.is_other);
        const otherSelected = otherOption && (t === 'multiple_choice'
            ? updates.response_option_index === otherOption.option_index
            : t === 'multi_select'
                && updates.response_multi_indices.split(',').map(Number).includes(otherOption.option_index));
        if (otherSelected) {
            const raw = body.otherText !== undefined ? body.otherText : responseRow.response_other_text;
            if (raw != null && typeof raw !== 'string') {
                return res.status(400).json({ status: 'error', message: 'otherText must be a string' });
            }
            updates.response_other_text = raw && raw.trim() ? raw.trim() : null;
        }

        await runAsync(
            `UPDATE survey_responses
             SET response_value = ?, response_option_index = ?,
                 response_option_text = ?, response_multi_indices = ?,
                 response_other_text = ?
             WHERE id = ?`,
            [updates.response_value, updates.response_option_index,
             updates.response_option_text, updates.response_multi_indices,
             updates.response_other_text, responseRow.id]
        );

        await logAudit(
            req.user.id,
            'EDIT_RESPONSE',
            'survey_response',
            String(responseRow.id),
            oldSnapshot,
            { ...oldSnapshot, ...updates }
        );

        res.json({ status: 'success' });
    } catch (err) {
        console.error('Edit response error:', err);
        res.status(500).json({ status: 'error', message: 'Failed to edit response' });
    }
});

/**
 * Set a response to missing — nullify the value columns but keep the row.
 * The question stays visible in the Edit Data detail page so the admin can
 * tell it was intentionally cleared (and re-add an answer later). Exports
 * treat null value columns as blank cells.
 */
router.post('/admin/subjects/:id/responses/:shortName/clear', requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const shortName = req.params.shortName;
        if (!Number.isInteger(id) || !shortName) {
            return res.status(400).json({ status: 'error', message: 'Invalid params' });
        }

        const subject = await loadSubject(id);
        if (!subject) {
            return res.status(404).json({ status: 'error', message: 'Subject not found' });
        }

        const responseRow = await getAsync(
            `SELECT id, completed_survey_id, question_id, question_index,
                    question_short_name, response_value, response_option_index,
                    response_option_text, response_multi_indices, answer_type,
                    response_other_text
             FROM survey_responses
             WHERE completed_survey_id = ? AND question_short_name = ?`,
            [id, shortName]
        );
        if (!responseRow) {
            return res.json({ status: 'success', message: 'Already missing', alreadyMissing: true });
        }
        const allNull =
            responseRow.response_value === null &&
            responseRow.response_option_index === null &&
            responseRow.response_option_text === null &&
            responseRow.response_multi_indices === null &&
            responseRow.response_other_text === null;
        if (allNull) {
            return res.json({ status: 'success', message: 'Already missing', alreadyMissing: true });
        }

        await runAsync(
            `UPDATE survey_responses
             SET response_value = NULL,
                 response_option_index = NULL,
                 response_option_text = NULL,
                 response_multi_indices = NULL,
                 response_other_text = NULL
             WHERE id = ?`,
            [responseRow.id]
        );

        await logAudit(
            req.user.id,
            'CLEAR_RESPONSE',
            'survey_response',
            String(responseRow.id),
            responseRow,
            {
                ...responseRow,
                response_value: null,
                response_option_index: null,
                response_option_text: null,
                response_multi_indices: null,
                response_other_text: null
            }
        );

        res.json({ status: 'success' });
    } catch (err) {
        console.error('Clear response error:', err);
        res.status(500).json({ status: 'error', message: 'Failed to clear response' });
    }
});

// ---- Rapid test results ---------------------------------------------------
//
// rapid_test_results is keyed by (completed_survey_id, test_id). The `result`
// column is NOT NULL, so "Set to Missing" deletes the row rather than
// nullifying — matches the "no test recorded" state visible in exports
// (rapid_<test_id>_result will simply be absent).

const RAPID_RESULTS = new Set(['positive', 'negative', 'indeterminate']);

router.put('/admin/subjects/:id/rapid-tests/:testId', requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const testId = req.params.testId;
        if (!Number.isInteger(id) || !testId) {
            return res.status(400).json({ status: 'error', message: 'Invalid params' });
        }
        const subject = await loadSubject(id);
        if (!subject) {
            return res.status(404).json({ status: 'error', message: 'Subject not found' });
        }
        const row = await getAsync(
            `SELECT id, completed_survey_id, test_id, test_name, result, recorded_at
             FROM rapid_test_results
             WHERE completed_survey_id = ? AND test_id = ?`,
            [id, testId]
        );
        if (!row) {
            return res.status(404).json({ status: 'error', message: 'Rapid test not found' });
        }
        const newResult = (req.body || {}).result;
        if (!RAPID_RESULTS.has(newResult)) {
            return res.status(400).json({
                status: 'error',
                message: `result must be one of ${[...RAPID_RESULTS].join(', ')}`
            });
        }
        await runAsync(
            `UPDATE rapid_test_results SET result = ? WHERE id = ?`,
            [newResult, row.id]
        );
        await logAudit(
            req.user.id, 'EDIT_RAPID_TEST', 'rapid_test_result',
            String(row.id), row, { ...row, result: newResult }
        );
        res.json({ status: 'success' });
    } catch (err) {
        console.error('Edit rapid test error:', err);
        res.status(500).json({ status: 'error', message: 'Failed to edit rapid test' });
    }
});

// Intentionally no clear/delete endpoint for rapid tests: rapid_test_results.result
// is NOT NULL so the only way to "clear" would be to delete the row, and there's
// no UI to re-add a rapid test record afterward — making the action effectively
// destructive. Edit-only.

// ---- Lab results ----------------------------------------------------------
//
// Keyed directly by lab_results.id since a subject may have multiple rows for
// the same test (re-runs, etc.). Validation matches the lab_test_configurations
// definition (dropdown options OR numeric range). "Set to Missing" deletes
// the row (cleaner than two-null-columns state).

router.put('/admin/lab-results/:resultId', requireAdmin, async (req, res) => {
    try {
        const resultId = parseInt(req.params.resultId, 10);
        if (!Number.isInteger(resultId)) {
            return res.status(400).json({ status: 'error', message: 'Invalid resultId' });
        }
        const row = await getAsync(
            `SELECT lr.id, lr.subject_id, lr.test_id, lr.result_value, lr.result_numeric,
                    ltc.test_type, ltc.options, ltc.min_value, ltc.max_value, ltc.unit
             FROM lab_results lr
             JOIN lab_test_configurations ltc ON ltc.id = lr.test_id
             WHERE lr.id = ?`,
            [resultId]
        );
        if (!row) {
            return res.status(404).json({ status: 'error', message: 'Lab result not found' });
        }
        const body = req.body || {};
        let resultValue = null;
        let resultNumeric = null;
        if (row.test_type === 'dropdown') {
            const raw = body.value;
            if (typeof raw !== 'string' || raw.trim() === '') {
                return res.status(400).json({ status: 'error', message: 'value required for dropdown lab test' });
            }
            let allowed;
            try {
                allowed = JSON.parse(row.options || '[]');
            } catch (e) {
                allowed = [];
            }
            if (Array.isArray(allowed) && allowed.length && !allowed.includes(raw)) {
                return res.status(400).json({
                    status: 'error',
                    message: `value must be one of: ${allowed.join(', ')}`
                });
            }
            resultValue = raw;
        } else if (row.test_type === 'numeric') {
            const raw = body.value;
            const n = Number(raw);
            if (!Number.isFinite(n)) {
                return res.status(400).json({ status: 'error', message: 'value must be a number' });
            }
            if (row.min_value !== null && n < row.min_value) {
                return res.status(400).json({ status: 'error', message: `value must be ≥ ${row.min_value}` });
            }
            if (row.max_value !== null && n > row.max_value) {
                return res.status(400).json({ status: 'error', message: `value must be ≤ ${row.max_value}` });
            }
            resultNumeric = n;
        } else {
            return res.status(400).json({ status: 'error', message: `unsupported lab test_type: ${row.test_type}` });
        }

        const oldSnapshot = { id: row.id, subject_id: row.subject_id, test_id: row.test_id,
                              result_value: row.result_value, result_numeric: row.result_numeric };
        await runAsync(
            `UPDATE lab_results SET result_value = ?, result_numeric = ? WHERE id = ?`,
            [resultValue, resultNumeric, resultId]
        );
        await logAudit(
            req.user.id, 'EDIT_LAB_RESULT', 'lab_result',
            String(resultId), oldSnapshot,
            { ...oldSnapshot, result_value: resultValue, result_numeric: resultNumeric }
        );
        res.json({ status: 'success' });
    } catch (err) {
        console.error('Edit lab result error:', err);
        res.status(500).json({ status: 'error', message: 'Failed to edit lab result' });
    }
});

router.post('/admin/lab-results/:resultId/clear', requireAdmin, async (req, res) => {
    try {
        const resultId = parseInt(req.params.resultId, 10);
        if (!Number.isInteger(resultId)) {
            return res.status(400).json({ status: 'error', message: 'Invalid resultId' });
        }
        const row = await getAsync(
            `SELECT id, subject_id, test_id, result_value, result_numeric
             FROM lab_results WHERE id = ?`,
            [resultId]
        );
        if (!row) {
            return res.json({ status: 'success', alreadyMissing: true });
        }
        await runAsync(`DELETE FROM lab_results WHERE id = ?`, [resultId]);
        await logAudit(
            req.user.id, 'CLEAR_LAB_RESULT', 'lab_result',
            String(resultId), row, null
        );
        res.json({ status: 'success' });
    } catch (err) {
        console.error('Clear lab result error:', err);
        res.status(500).json({ status: 'error', message: 'Failed to clear lab result' });
    }
});

module.exports = router;
