/**
 * POST /api/jexl/check — checks one script as the editor types it, before it
 * is saved. The script is checked in the context of its survey, with the
 * unsaved text swapped in for the stored one.
 *
 * Body:
 *   field        pre_script | validation_script | skip_to_script |
 *                eligibility_script | coupon_count_script | jexl_condition
 *   src          the script text
 *   survey_id    the survey (not needed for jexl_condition; the active survey is used)
 *   question_id  the question being edited (omit for a new question)
 *   For a new question, optionally: short_name, question_type, question_index,
 *   section_id, options ([{ is_other }]).
 *   skip_to_target  for skip_to_script, the unsaved target
 *   test_name    for jexl_condition, the lab test's name
 *
 * Returns { errors, warnings, checked } for that field only.
 */

const express = require('express');
const database = require('../../models/database');
const { requireAdmin } = require('../../middleware/auth');
const { checkSurveyData, loadSurveyData, filterIssues, checkLabConditions } = require('../../services/jexlCheck');

const router = express.Router();
router.use(requireAdmin);

const QUESTION_FIELDS = ['pre_script', 'validation_script', 'skip_to_script'];
const SURVEY_FIELDS = ['eligibility_script', 'coupon_count_script'];
const NEW_QUESTION_ID = -1;

async function activeSurveyData() {
    const active = await database.getAsync('SELECT id FROM surveys WHERE is_active = 1 ORDER BY id DESC LIMIT 1');
    return active ? loadSurveyData(database, active.id) : null;
}

router.post('/check', async (req, res) => {
    const { field, survey_id: surveyId, question_id: questionId } = req.body || {};
    const src = typeof req.body?.src === 'string' ? req.body.src : '';

    try {
        if (field === 'jexl_condition') {
            const name = req.body.test_name || 'this test';
            const result = await checkLabConditions([{ test_name: name, jexl_condition: src }], await activeSurveyData());
            return res.json(result);
        }

        if (!QUESTION_FIELDS.includes(field) && !SURVEY_FIELDS.includes(field)) {
            return res.status(400).json({ error: `Unknown field "${field}"` });
        }
        const data = await loadSurveyData(database, surveyId);
        if (!data) return res.status(404).json({ error: 'Survey not found' });

        if (SURVEY_FIELDS.includes(field)) {
            data.survey = { ...data.survey, [field]: src };
            return res.json(filterIssues(await checkSurveyData(data), { fields: [field] }));
        }

        let question;
        if (questionId != null && questionId !== '') {
            const existing = data.questions.find(q => q.id === Number(questionId));
            if (!existing) return res.status(404).json({ error: 'Question not found' });
            question = { ...existing };
            data.questions = data.questions.filter(q => q !== existing);
        } else {
            const lastIndex = data.questions.reduce((m, q) => Math.max(m, q.question_index ?? 0), -1);
            question = {
                id: NEW_QUESTION_ID,
                short_name: req.body.short_name || '(new question)',
                question_type: req.body.question_type || 'multiple_choice',
                question_index: req.body.question_index ?? lastIndex + 1,
                section_id: req.body.section_id ?? null
            };
            const opts = Array.isArray(req.body.options) ? req.body.options : [];
            data.options.push(...opts.map((o, i) => ({
                question_id: NEW_QUESTION_ID, option_index: i, is_other: o && o.is_other
            })));
        }
        question[field] = src;
        if (field === 'skip_to_script' && req.body.skip_to_target !== undefined) {
            question.skip_to_target = req.body.skip_to_target;
        }
        data.questions.push(question);

        const fields = field === 'skip_to_script' ? [field, 'skip_to_target'] : [field];
        res.json(filterIssues(await checkSurveyData(data), { questionId: question.id, fields }));
    } catch (error) {
        console.error('Error checking script:', error);
        res.status(500).json({ error: 'Failed to check script' });
    }
});

module.exports = router;
