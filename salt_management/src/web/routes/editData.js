/**
 * Edit Data Web Routes
 *
 * Admin-only pages for soft-deleting subjects and editing individual survey
 * responses. JSON actions live in src/api/routes/subjectManagement.js — these
 * routes only render the EJS UI.
 */
const express = require('express');
const { getAsync, allAsync } = require('../../models/database');
const { requireAdmin } = require('../../middleware/auth');
const { neutralizeFormula } = require('../../services/csvSafety');
const router = express.Router();

function extractText(jsonStr) {
    if (!jsonStr) return '';
    try {
        const parsed = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
        return parsed.en || Object.values(parsed)[0] || '';
    } catch (e) {
        return String(jsonStr);
    }
}

router.get('/edit-data', requireAdmin, async (req, res) => {
    try {
        const facilityFilter = req.query.facility ? parseInt(req.query.facility, 10) : null;
        const showDeleted = req.query.showDeleted === '1';

        const where = [];
        const params = [];
        if (Number.isInteger(facilityFilter)) {
            where.push('cs.facility_id = ?');
            params.push(facilityFilter);
        }
        if (!showDeleted) {
            where.push('cs.deleted_at IS NULL');
        }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

        const subjects = await allAsync(
            `SELECT cs.id, cs.survey_response_id, cs.participant_id,
                    cs.facility_id, cs.completed_at, cs.deleted_at,
                    f.name AS facility_name
             FROM completed_surveys cs
             LEFT JOIN facilities f ON f.id = cs.facility_id
             ${whereSql}
             ORDER BY cs.completed_at DESC
             LIMIT 500`,
            params
        );

        const facilities = await allAsync(
            `SELECT id, name FROM facilities ORDER BY name`
        );

        res.render('pages/editDataList', {
            title: 'Edit Data',
            user: req.user,
            subjects,
            facilities,
            selectedFacility: facilityFilter,
            showDeleted
        });
    } catch (err) {
        console.error('Edit Data list error:', err);
        res.status(500).render('pages/error', {
            title: 'Error',
            message: 'Failed to load subjects'
        });
    }
});

// Constrain :id to digits so it doesn't shadow sibling routes like
// /edit-data/audit-log.csv (Express would otherwise match :id="audit-log.csv").
router.get('/edit-data/:id(\\d+)', requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id)) {
            return res.status(404).render('pages/error', {
                title: 'Not Found', message: 'Invalid subject id'
            });
        }

        const subject = await getAsync(
            `SELECT cs.id, cs.survey_response_id, cs.participant_id,
                    cs.facility_id, cs.survey_id, cs.completed_at,
                    cs.language, cs.deleted_at, cs.deleted_by,
                    f.name AS facility_name
             FROM completed_surveys cs
             LEFT JOIN facilities f ON f.id = cs.facility_id
             WHERE cs.id = ?`,
            [id]
        );
        if (!subject) {
            return res.status(404).render('pages/error', {
                title: 'Not Found', message: 'Subject not found'
            });
        }

        // Pull responses + the matching question (for type and options) in one
        // pass. Scoped to this subject's survey so we pick the right options.
        const responses = await allAsync(
            `SELECT sr.id, sr.question_short_name, sr.question_index,
                    sr.response_value, sr.response_option_index,
                    sr.response_option_text, sr.response_multi_indices,
                    sr.answer_type, sr.response_other_text,
                    q.id AS question_id, q.question_text_json,
                    q.question_type, q.min_selections, q.max_selections
             FROM survey_responses sr
             LEFT JOIN questions q
                ON q.short_name = sr.question_short_name
                AND q.survey_id = ?
             WHERE sr.completed_survey_id = ?
             ORDER BY sr.question_index`,
            [subject.survey_id, id]
        );

        // Bulk-load options for every question_id we touched.
        const questionIds = Array.from(new Set(
            responses.map(r => r.question_id).filter(Boolean)
        ));
        const optionsByQuestion = {};
        if (questionIds.length) {
            const placeholders = questionIds.map(() => '?').join(',');
            const optRows = await allAsync(
                `SELECT question_id, option_index, option_text_json, is_other
                 FROM options
                 WHERE question_id IN (${placeholders})
                 ORDER BY question_id, option_index`,
                questionIds
            );
            for (const o of optRows) {
                (optionsByQuestion[o.question_id] = optionsByQuestion[o.question_id] || [])
                    .push({ index: o.option_index, text: extractText(o.option_text_json), isOther: !!o.is_other });
            }
        }

        // Shape each response for the template. Prefer questions.question_type
        // (the authoritative schema) over survey_responses.answer_type — the
        // latter can drift if the tablet wrote a stale value at upload time.
        // Fall back to answer_type only when the question definition is gone
        // (e.g. the question was deleted after this response was captured).
        const items = responses.map(r => {
            const answerType = r.question_type || r.answer_type;
            let selectedIndices = [];
            if (answerType === 'multi_select' && typeof r.response_multi_indices === 'string') {
                selectedIndices = r.response_multi_indices
                    .split(',')
                    .map(s => parseInt(s.trim(), 10))
                    .filter(n => Number.isInteger(n));
            }
            return {
                id: r.id,
                shortName: r.question_short_name,
                questionText: extractText(r.question_text_json) || `(${r.question_short_name})`,
                answerType,
                responseValue: r.response_value,
                responseOptionIndex: r.response_option_index,
                responseOptionText: r.response_option_text,
                otherText: r.response_other_text,
                selectedIndices,
                options: optionsByQuestion[r.question_id] || [],
                minSelections: r.min_selections,
                maxSelections: r.max_selections
            };
        });

        // Rapid test results, joined with the test configuration so we know
        // which result options are valid. test_configurations is per-survey;
        // we don't strictly need it for editing (result is a fixed enum) but
        // we keep test_name available for display.
        const rapidTests = await allAsync(
            `SELECT rt.id, rt.test_id, rt.test_name, rt.result, rt.recorded_at
             FROM rapid_test_results rt
             WHERE rt.completed_survey_id = ?
             ORDER BY rt.recorded_at`,
            [id]
        );

        // Lab results are keyed by participant_id (text), not completed_survey
        // id. Join the configuration so the edit modal can present the right
        // widget (dropdown options vs numeric input + min/max).
        const labResults = await allAsync(
            `SELECT lr.id, lr.subject_id, lr.test_id, lr.result_value, lr.result_numeric,
                    lr.created_at,
                    ltc.test_name, ltc.test_type, ltc.options, ltc.min_value,
                    ltc.max_value, ltc.unit
             FROM lab_results lr
             JOIN lab_test_configurations ltc ON ltc.id = lr.test_id
             WHERE lr.subject_id = ?
             ORDER BY lr.created_at`,
            [subject.participant_id]
        );

        const labItems = labResults.map(r => {
            let options = [];
            if (r.test_type === 'dropdown' && r.options) {
                try {
                    const parsed = JSON.parse(r.options);
                    if (Array.isArray(parsed)) options = parsed;
                } catch (e) { /* leave empty */ }
            }
            return {
                id: r.id,
                testId: r.test_id,
                testName: r.test_name,
                testType: r.test_type,
                resultValue: r.result_value,
                resultNumeric: r.result_numeric,
                options,
                minValue: r.min_value,
                maxValue: r.max_value,
                unit: r.unit,
                createdAt: r.created_at
            };
        });

        res.render('pages/editDataSubject', {
            title: `Edit Data — ${subject.participant_id}`,
            user: req.user,
            subject,
            items,
            rapidTests,
            labItems
        });
    } catch (err) {
        console.error('Edit Data detail error:', err);
        res.status(500).render('pages/error', {
            title: 'Error', message: 'Failed to load subject detail'
        });
    }
});

// ---- Edit log download ----------------------------------------------------
//
// CSV of every Edit Data action recorded in audit_log. Joined to admin_users
// for the operator name, completed_surveys for the participant + facility,
// and lab_test_configurations for the lab test name. Columns chosen for
// human readability over raw fidelity — the full JSON snapshots are still in
// audit_log itself (and the on-disk JSONL backup) if a more detailed
// reconstruction is needed.

const EDIT_LOG_ACTIONS = [
    'DELETE_SUBJECT',
    'RESTORE_SUBJECT',
    'EDIT_RESPONSE',
    'CLEAR_RESPONSE',
    'EDIT_RAPID_TEST',
    'EDIT_LAB_RESULT',
    'CLEAR_LAB_RESULT'
];

function tryParse(s) {
    if (s === null || s === undefined) return null;
    try { return typeof s === 'string' ? JSON.parse(s) : s; } catch (e) { return null; }
}

function csvEscape(v) {
    if (v === null || v === undefined) return '';
    const s = neutralizeFormula(v); // download-only file
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

// Per-action projection: returns { subject, variable, oldValue, newValue }.
// subject is a numeric completed_surveys.id when we need to look it up later;
// otherwise the participant_id (lab actions carry it directly).
function projectRow(row, csById, labNameByTestId) {
    const o = tryParse(row.old_value);
    const n = tryParse(row.new_value);
    const result = { subject: '', facility: '', variable: '', oldValue: '', newValue: '' };

    const resolveSubject = (csId) => {
        if (csId == null) return;
        const cs = csById.get(Number(csId));
        if (cs) { result.subject = cs.participant_id; result.facility = cs.facility_name || ''; }
    };

    switch (row.action) {
        case 'DELETE_SUBJECT':
            resolveSubject(row.entity_id);
            result.variable = '(subject)';
            result.oldValue = '(active)';
            result.newValue = 'deleted';
            break;
        case 'RESTORE_SUBJECT':
            resolveSubject(row.entity_id);
            result.variable = '(subject)';
            result.oldValue = 'deleted';
            result.newValue = '(active)';
            break;
        case 'EDIT_RESPONSE':
        case 'CLEAR_RESPONSE': {
            resolveSubject(o && o.completed_survey_id);
            const shortName = (o && o.question_short_name) || (n && n.question_short_name) || '?';
            result.variable = 'q_' + shortName;
            const at = (o && o.answer_type) || (n && n.answer_type);
            const fmt = (snap) => {
                if (!snap) return '';
                const other = snap.response_other_text ? ` (other: ${snap.response_other_text})` : '';
                if (at === 'multiple_choice') {
                    if (snap.response_option_index == null) return '';
                    const txt = snap.response_option_text ? `: ${snap.response_option_text}` : '';
                    return `${snap.response_option_index}${txt}${other}`;
                }
                if (at === 'multi_select') return (snap.response_multi_indices || '') + other;
                return snap.response_value == null ? '' : String(snap.response_value);
            };
            result.oldValue = fmt(o);
            result.newValue = row.action === 'CLEAR_RESPONSE' ? '(missing)' : fmt(n);
            break;
        }
        case 'EDIT_RAPID_TEST': {
            resolveSubject(o && o.completed_survey_id);
            const testId = (o && o.test_id) || (n && n.test_id) || '?';
            result.variable = `rapid_${testId}_result`;
            result.oldValue = (o && o.result) || '';
            result.newValue = (n && n.result) || '';
            break;
        }
        case 'EDIT_LAB_RESULT':
        case 'CLEAR_LAB_RESULT': {
            // subject_id on lab_results IS the participant_id (text)
            const subjectId = (o && o.subject_id) || (n && n.subject_id) || '';
            result.subject = subjectId;
            const testId = (o && o.test_id) || (n && n.test_id);
            result.variable = labNameByTestId.get(Number(testId)) || `lab_${testId}`;
            const fmtLab = (snap) => {
                if (!snap) return '';
                if (snap.result_numeric != null) return String(snap.result_numeric);
                if (snap.result_value != null) return String(snap.result_value);
                return '';
            };
            result.oldValue = fmtLab(o);
            result.newValue = row.action === 'CLEAR_LAB_RESULT' ? '(deleted)' : fmtLab(n);
            break;
        }
        default:
            result.variable = row.entity_type || '';
    }
    return result;
}

router.get('/edit-data/audit-log.csv', requireAdmin, async (req, res) => {
    try {
        const placeholders = EDIT_LOG_ACTIONS.map(() => '?').join(',');
        const auditRows = await allAsync(
            `SELECT al.id, al.timestamp, al.action, al.entity_type, al.entity_id,
                    al.old_value, al.new_value, u.username AS user_name
             FROM audit_log al
             LEFT JOIN admin_users u ON u.id = al.user_id
             WHERE al.action IN (${placeholders})
             ORDER BY al.timestamp DESC`,
            EDIT_LOG_ACTIONS
        );

        const csRows = await allAsync(`
            SELECT cs.id, cs.participant_id, f.name AS facility_name
            FROM completed_surveys cs
            LEFT JOIN facilities f ON f.id = cs.facility_id
        `);
        const csById = new Map(csRows.map(r => [r.id, r]));

        const labConfigs = await allAsync(`SELECT id, test_name FROM lab_test_configurations`);
        const labNameByTestId = new Map(labConfigs.map(r => [r.id, r.test_name]));

        const header = ['edit_date', 'user', 'action', 'subject', 'facility',
                        'variable', 'old_value', 'new_value', 'entity_type', 'entity_id'];
        const lines = [header.join(',')];
        for (const row of auditRows) {
            const p = projectRow(row, csById, labNameByTestId);
            lines.push([
                csvEscape(row.timestamp),
                csvEscape(row.user_name || ''),
                csvEscape(row.action),
                csvEscape(p.subject),
                csvEscape(p.facility),
                csvEscape(p.variable),
                csvEscape(p.oldValue),
                csvEscape(p.newValue),
                csvEscape(row.entity_type),
                csvEscape(row.entity_id)
            ].join(','));
        }

        const filename = `edit-log-${new Date().toISOString().slice(0, 10)}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(lines.join('\n'));
    } catch (err) {
        console.error('Edit log download error:', err);
        res.status(500).render('pages/error', {
            title: 'Error', message: 'Failed to build edit log'
        });
    }
});

module.exports = router;
