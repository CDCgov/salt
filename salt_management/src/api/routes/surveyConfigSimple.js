const express = require('express');
const { body, validationResult } = require('express-validator');
const { getAsync, runAsync, allAsync } = require('../../models/database');
const { requireAdmin } = require('../../middleware/auth');
const { logAudit } = require('../../services/auditService');
const database = require('../../models/database');
const { checkSurvey } = require('../../services/jexlCheck');
const editing = require('../../services/surveyEditing');
const { reservedShortNameError } = require('../../services/builtinVariables');
const { jexlReport } = editing;
const router = express.Router();

// Shared-service failures carry an HTTP status; anything else is a 500.
function sendEditError(res, error, fallback) {
    if (error instanceof editing.EditError) {
        return res.status(error.status).json({ error: error.message });
    }
    console.error(fallback + ':', error);
    return res.status(500).json({ error: fallback });
}

// All routes require admin authentication
router.use(requireAdmin);

// List all survey versions
router.get('/', async (req, res) => {
    try {
        const surveys = await allAsync(
            `SELECT s.*, 
                    COUNT(DISTINCT q.id) as question_count
             FROM surveys s
             LEFT JOIN questions q ON s.id = q.survey_id
             GROUP BY s.id
             ORDER BY s.version DESC`
        );
        res.json(surveys);
    } catch (error) {
        console.error('Error fetching surveys:', error);
        res.status(500).json({ error: 'Failed to fetch surveys' });
    }
});

// Get single survey with all questions and options
router.get('/:id', async (req, res) => {
    try {
        const survey = await getAsync(
            'SELECT * FROM surveys WHERE id = ?',
            [req.params.id]
        );
        
        if (!survey) {
            return res.status(404).json({ error: 'Survey not found' });
        }
        
        // Parse languages if stored as JSON string
        if (survey.languages && typeof survey.languages === 'string') {
            survey.languages = JSON.parse(survey.languages);
        }
        
        // Parse eligibility message if stored as JSON string
        if (survey.eligibility_message_json && typeof survey.eligibility_message_json === 'string') {
            survey.eligibility_message_json = JSON.parse(survey.eligibility_message_json);
        }
        
        // Get sections
        const sections = await allAsync(
            'SELECT * FROM sections WHERE survey_id = ? ORDER BY section_index',
            [req.params.id]
        );
        
        // Get questions with options
        const questions = await allAsync(
            'SELECT * FROM questions WHERE survey_id = ? ORDER BY question_index',
            [req.params.id]
        );
        
        // Get options for each question and parse JSON fields
        const questionsWithOptions = await Promise.all(
            questions.map(async (question) => {
                // Parse JSON fields
                if (question.question_text_json) {
                    question.question_text_json = JSON.parse(question.question_text_json);
                }
                if (question.audio_files_json) {
                    question.audio_files_json = JSON.parse(question.audio_files_json);
                }
                if (question.validation_error_json) {
                    question.validation_error_json = JSON.parse(question.validation_error_json);
                }
                
                const options = await allAsync(
                    'SELECT * FROM options WHERE question_id = ? ORDER BY option_index',
                    [question.id]
                );
                
                // Parse JSON fields in options
                options.forEach(opt => {
                    if (opt.option_text_json) {
                        opt.option_text_json = JSON.parse(opt.option_text_json);
                    }
                    if (opt.audio_files_json) {
                        opt.audio_files_json = JSON.parse(opt.audio_files_json);
                    }
                });
                
                return { ...question, options };
            })
        );
        
        // Organize questions by section
        const sectionsWithQuestions = sections.map(section => ({
            ...section,
            questions: questionsWithOptions.filter(q => q.section_id === section.id)
        }));
        
        res.json({ 
            ...survey, 
            sections: sectionsWithQuestions,
            questions: questionsWithOptions // Keep for backward compatibility
        });
    } catch (error) {
        console.error('Error fetching survey:', error);
        res.status(500).json({ error: 'Failed to fetch survey' });
    }
});

// Update survey (creates new version)
router.put('/:id', [
    body('name').optional().trim(),
    body('description').optional().trim(),
    body('languages').optional(),
    body('eligibility_script').optional().trim(),
    body('coupon_count_script').optional().trim(),
    body('eligibility_message_json').optional(),
    body('create_version').optional().isBoolean(),
    body('fingerprint_enabled').optional().isInt({ min: 0, max: 1 }),
    body('re_enrollment_days').optional().isInt({ min: 1, max: 365 }),
    body('staff_validation_message_json').optional(),
    body('contact_info_enabled').optional().isInt({ min: 0, max: 1 }),
    body('staff_eligibility_screening').optional().isInt({ min: 0, max: 1 }),
    body('rapid_test_samples_after_eligibility').optional().isInt({ min: 0, max: 1 }),
    body('payment_audit_phone_enabled').optional().isInt({ min: 0, max: 1 })
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        console.error('Validation errors:', JSON.stringify(errors.array()));
        return res.status(400).json({ errors: errors.array() });
    }

    const { name, description, languages, eligibility_script, coupon_count_script, eligibility_message_json, create_version = false, fingerprint_enabled, re_enrollment_days, staff_validation_message_json, contact_info_enabled, staff_eligibility_screening, rapid_test_samples_after_eligibility, payment_audit_phone_enabled } = req.body;
    const surveyId = req.params.id;
    
    console.log('Update survey request:', {
        surveyId,
        fingerprint_enabled,
        re_enrollment_days,
        languages,
        body: req.body
    });
    
    try {
        const oldSurvey = await getAsync(
            'SELECT * FROM surveys WHERE id = ?',
            [surveyId]
        );
        
        if (!oldSurvey) {
            return res.status(404).json({ error: 'Survey not found' });
        }
        
        // If create_version is true and survey is not a draft, create a new
        // version: a full copy (settings, questions, options, messages, rapid
        // tests, audio) with this request's settings applied.
        if (create_version && !oldSurvey.is_draft) {
            const result = await editing.createVersion(surveyId, req.body, { userId: req.session.userId, via: 'web' });
            res.json({
                message: 'New survey version created successfully',
                newSurveyId: result.surveyId,
                version: result.version,
                jexl_check: await jexlReport(result.surveyId, { fields: ['eligibility_script', 'coupon_count_script'] })
            });

        } else {
            // Update the existing survey (for drafts or when create_version is false)
            await editing.updateSurveySettings(surveyId, req.body, { userId: req.session.userId, via: 'web' });

            res.json({
                message: 'Survey updated successfully',
                jexl_check: await jexlReport(surveyId, { fields: ['eligibility_script', 'coupon_count_script'] })
            });
        }
    } catch (error) {
        sendEditError(res, error, 'Failed to update survey');
    }
});

// Add question with multi-language support
router.post('/:surveyId/questions', [
    body('question_index').isInt(),
    body('short_name').notEmpty().trim()
        .matches(/^[a-zA-Z_][a-zA-Z0-9_]*$/).withMessage('Short name must start with a letter, and contain only letters, numbers, and underscores')
        .custom((v) => {
            // `value`, `facility_coupons` and names starting with "_" are
            // built-in JEXL variables (see services/builtinVariables.js).
            const reserved = reservedShortNameError(v);
            if (reserved) throw new Error(reserved);
            return true;
        }),
    body('question_text_json').isObject(),
    body('audio_files_json').optional({ nullable: true, checkFalsy: true }).isObject(),
    body('question_type').isIn(['multiple_choice', 'numeric', 'text', 'multi_select', 'info']),
    body('validation_script').optional({ nullable: true, checkFalsy: true }).trim(),
    body('validation_error_json').optional({ nullable: true, checkFalsy: true }).isObject(),
    body('pre_script').optional({ nullable: true, checkFalsy: true }).trim(),
    // nullable/checkFalsy so an empty section dropdown (NaN -> null) is skipped, not rejected as "Invalid value"
    body('section_id').optional({ nullable: true, checkFalsy: true }).isInt(),
    body('options').optional({ nullable: true }).isArray(),
    body('min_selections').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
    body('max_selections').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
    body('skip_to_script').optional({ nullable: true, checkFalsy: true }).trim(),
    body('skip_to_target').optional({ nullable: true, checkFalsy: true }).trim().matches(/^[a-zA-Z0-9_]*$/)
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        console.error('Validation errors:', JSON.stringify(errors.array()));
        return res.status(400).json({ errors: errors.array() });
    }

    const surveyId = req.params.surveyId;

    try {
        const { id: questionId } = await editing.addQuestion(surveyId, req.body, { userId: req.session.userId, via: 'web' });
        res.status(201).json({
            id: questionId,
            message: 'Question added successfully',
            jexl_check: await jexlReport(surveyId, { questionId })
        });
    } catch (error) {
        sendEditError(res, error, 'Failed to add question');
    }
});

// Update question with multi-language support
router.put('/:surveyId/questions/:questionId', [
    body('question_index').optional().isInt(),
    body('short_name').optional().trim()
        .matches(/^[a-zA-Z_][a-zA-Z0-9_]*$/).withMessage('Short name must start with a letter, and contain only letters, numbers, and underscores')
        .custom((v) => {
            // `value`, `facility_coupons` and names starting with "_" are
            // built-in JEXL variables (see services/builtinVariables.js).
            const reserved = reservedShortNameError(v);
            if (reserved) throw new Error(reserved);
            return true;
        }),
    body('question_text_json').optional({ nullable: true, checkFalsy: true }).isObject(),
    body('audio_files_json').optional({ nullable: true, checkFalsy: true }).isObject(),
    body('question_type').optional({ nullable: true, checkFalsy: true }).isIn(['multiple_choice', 'numeric', 'text', 'multi_select', 'info']),
    body('validation_script').optional({ nullable: true, checkFalsy: true }).trim(),
    body('validation_error_json').optional({ nullable: true, checkFalsy: true }).isObject(),
    body('pre_script').optional({ nullable: true, checkFalsy: true }).trim(),
    // nullable/checkFalsy so an empty section dropdown (NaN -> null) is skipped, not rejected as "Invalid value"
    body('section_id').optional({ nullable: true, checkFalsy: true }).isInt(),
    body('options').optional({ nullable: true }).isArray(),
    body('min_selections').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
    body('max_selections').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
    body('skip_to_script').optional({ nullable: true, checkFalsy: true }).trim(),
    body('skip_to_target').optional({ nullable: true, checkFalsy: true }).trim().matches(/^[a-zA-Z0-9_]*$/)
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        console.error('Validation errors:', JSON.stringify(errors.array()));
        return res.status(400).json({ errors: errors.array() });
    }

    const { surveyId, questionId } = req.params;

    try {
        await editing.updateQuestion(surveyId, Number(questionId), req.body, { userId: req.session.userId, via: 'web' });
        res.json({
            message: 'Question updated successfully',
            jexl_check: await jexlReport(surveyId, { questionId: Number(questionId) })
        });
    } catch (error) {
        sendEditError(res, error, 'Failed to update question');
    }
});

// Delete question
router.delete('/:surveyId/questions/:questionId', async (req, res) => {
    const { surveyId, questionId } = req.params;

    try {
        await editing.deleteQuestion(surveyId, Number(questionId), { userId: req.session.userId, via: 'web' });
        res.json({ message: 'Question deleted successfully' });
    } catch (error) {
        sendEditError(res, error, 'Failed to delete question');
    }
});

// Reorder questions
router.post('/:surveyId/reorder', [
    body('questionOrder').isArray()
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        console.error('Validation errors:', JSON.stringify(errors.array()));
        return res.status(400).json({ errors: errors.array() });
    }

    const { surveyId } = req.params;
    const { questionOrder } = req.body;

    try {
        await editing.reorderQuestions(surveyId, questionOrder, { userId: req.session.userId, via: 'web' });
        res.json({ message: 'Questions reordered successfully' });
    } catch (error) {
        sendEditError(res, error, 'Failed to reorder questions');
    }
});

// Create new survey version
router.post('/', [
    body('name').notEmpty().trim(),
    body('description').optional().trim(),
    body('languages').optional(),
    body('basedOnSurveyId').optional().isInt()
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        console.error('Validation errors:', JSON.stringify(errors.array()));
        return res.status(400).json({ errors: errors.array() });
    }

    const { name, description, languages, basedOnSurveyId } = req.body;

    // Copy of an existing survey: everything in it (settings, questions,
    // options, messages, rapid tests, audio), as a new survey at version 1.
    if (basedOnSurveyId) {
        try {
            const result = await editing.copyAsNewSurvey(basedOnSurveyId, { name, description, languages },
                { userId: req.session.userId, via: 'web' });
            return res.status(201).json({
                id: result.surveyId,
                version: result.version,
                name,
                description,
                message: 'Survey created successfully'
            });
        } catch (error) {
            return sendEditError(res, error, 'Failed to create survey');
        }
    }
    
    try {
        // New surveys always start at version 1
        const newVersion = 1;
        
        const surveyLanguages = languages || '["en"]';
        // Blank: a new survey has no eligibility questions yet, so any script
        // would refer to questions that don't exist. The checker warns until
        // one is written.
        const eligibilityScript = null;
        const eligibilityMessageJson = null;
        const fingerprintEnabled = 0;
        const reEnrollmentDays = 90;
        const staffValidationMessageJson = null;
        const hivRapidTestEnabled = 1;
        const couponCountScript = null;

        // Create a blank survey with default settings
        const result = await runAsync(
            `INSERT INTO surveys (version, base_survey_id, name, description, languages,
                                  eligibility_script, coupon_count_script, eligibility_message_json, fingerprint_enabled,
                                  re_enrollment_days, staff_validation_message_json, hiv_rapid_test_enabled,
                                  is_draft)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [newVersion, null, name, description, surveyLanguages, eligibilityScript, couponCountScript,
             eligibilityMessageJson, fingerprintEnabled, reEnrollmentDays,
             staffValidationMessageJson, hivRapidTestEnabled, 0]
        );
        
        const newSurveyId = result.id;
        
        // Set base_survey_id to itself for new surveys
        await runAsync('UPDATE surveys SET base_survey_id = ? WHERE id = ?', [newSurveyId, newSurveyId]);
        
        // Create default sections for the new survey
        await runAsync(
            `INSERT INTO sections (survey_id, section_index, section_type, name, description) 
             VALUES (?, ?, ?, ?, ?)`,
            [newSurveyId, 0, 'eligibility', 'Eligibility', 'Screening questions to determine eligibility']
        );
        
        await runAsync(
            `INSERT INTO sections (survey_id, section_index, section_type, name, description) 
             VALUES (?, ?, ?, ?, ?)`,
            [newSurveyId, 1, 'main', 'Main', 'Primary survey questions']
        );
        
        await logAudit(
            req.session.userId,
            'CREATE_SURVEY',
            'survey',
            newSurveyId,
            null,
            { name, description, version: newVersion }
        );
        
        res.status(201).json({
            id: newSurveyId,
            version: newVersion,
            name,
            description,
            message: 'Survey created successfully'
        });
    } catch (error) {
        console.error('Error creating survey:', error);
        res.status(500).json({ error: 'Failed to create survey' });
    }
});

// Activate a survey version (deactivates all others)
// Check every script in a survey (the editor's "Check survey" button)
router.get('/:id/check', async (req, res) => {
    try {
        const result = await checkSurvey(database, req.params.id);
        if (!result) return res.status(404).json({ error: 'Survey not found' });
        res.json(result);
    } catch (error) {
        console.error('Error checking survey:', error);
        res.status(500).json({ error: 'Failed to check survey' });
    }
});

router.post('/:id/activate', async (req, res) => {
    const surveyId = req.params.id;
    
    try {
        const survey = await getAsync(
            'SELECT * FROM surveys WHERE id = ?',
            [surveyId]
        );
        
        if (!survey) {
            return res.status(404).json({ error: 'Survey not found' });
        }

        // Block activation while the survey's scripts have errors, so broken
        // logic never reaches tablets. Warnings don't block.
        let check = null;
        try {
            check = await checkSurvey(database, surveyId);
        } catch (err) {
            console.error('JEXL check failed during activation:', err);
        }
        if (check && check.errors.length) {
            return res.status(409).json({
                error: `This survey has ${check.errors.length} script error(s). Fix them before activating.`,
                jexl_check: check
            });
        }
        
        // Deactivate all surveys
        await runAsync('UPDATE surveys SET is_active = 0');
        
        // Activate this survey
        await runAsync(
            'UPDATE surveys SET is_active = 1 WHERE id = ?',
            [surveyId]
        );
        
        await logAudit(
            req.session.userId,
            'ACTIVATE_SURVEY',
            'survey',
            surveyId,
            null,
            { version: survey.version, name: survey.name }
        );
        
        res.json({ message: 'Survey activated successfully', jexl_check: check });
    } catch (error) {
        console.error('Error activating survey:', error);
        res.status(500).json({ error: 'Failed to activate survey' });
    }
});

// Delete a survey
router.delete('/:id', async (req, res) => {
    const surveyId = req.params.id;
    
    try {
        // Check if survey exists
        const survey = await getAsync(
            'SELECT * FROM surveys WHERE id = ?',
            [surveyId]
        );
        
        if (!survey) {
            return res.status(404).json({ error: 'Survey not found' });
        }
        
        // Prevent deletion of active survey
        if (survey.is_active) {
            return res.status(400).json({ error: 'Cannot delete an active survey. Please activate another survey first.' });
        }
        
        // Check if this is the only survey
        const surveyCount = await getAsync(
            'SELECT COUNT(*) as count FROM surveys'
        );
        
        if (surveyCount.count <= 1) {
            return res.status(400).json({ error: 'Cannot delete the only survey. Create another survey first.' });
        }
        
        // Delete all survey responses first (they reference questions)
        await runAsync(
            `DELETE FROM survey_responses WHERE completed_survey_id IN (
                SELECT id FROM completed_surveys WHERE survey_id = ?
            )`,
            [surveyId]
        );

        // Delete all completed surveys for this survey
        await runAsync(
            'DELETE FROM completed_surveys WHERE survey_id = ?',
            [surveyId]
        );

        // Delete all options for questions in this survey
        await runAsync(
            `DELETE FROM options WHERE question_id IN (
                SELECT id FROM questions WHERE survey_id = ?
            )`,
            [surveyId]
        );

        // Delete all questions for this survey
        await runAsync(
            'DELETE FROM questions WHERE survey_id = ?',
            [surveyId]
        );

        // Delete all sections for this survey
        await runAsync(
            'DELETE FROM sections WHERE survey_id = ?',
            [surveyId]
        );

        // Delete all test configurations for this survey
        await runAsync(
            'DELETE FROM test_configurations WHERE survey_id = ?',
            [surveyId]
        );

        // Delete all survey messages for this survey
        await runAsync(
            'DELETE FROM survey_messages WHERE survey_id = ?',
            [surveyId]
        );

        // Update child surveys to remove parent reference
        await runAsync(
            'UPDATE surveys SET parent_survey_id = NULL WHERE parent_survey_id = ?',
            [surveyId]
        );

        // Delete the survey
        await runAsync(
            'DELETE FROM surveys WHERE id = ?',
            [surveyId]
        );
        
        await logAudit(
            req.session.userId,
            'DELETE_SURVEY',
            'survey',
            surveyId,
            survey,
            null
        );
        
        res.json({ message: 'Survey deleted successfully' });
    } catch (error) {
        console.error('Error deleting survey:', error);
        res.status(500).json({ error: 'Failed to delete survey' });
    }
});

module.exports = router;