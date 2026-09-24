const express = require('express');
const { body, validationResult } = require('express-validator');
const { getAsync, runAsync, allAsync } = require('../../models/database');
const { requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../../services/auditService');
const router = express.Router();

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
        
        // If create_version is true and survey is not a draft, create a new version
        if (create_version && !oldSurvey.is_draft) {
            // Get the next version number for this base survey
            const baseId = oldSurvey.base_survey_id || oldSurvey.id;
            const maxVersion = await getAsync(
                'SELECT MAX(version) as max_version FROM surveys WHERE base_survey_id = ? OR id = ?',
                [baseId, baseId]
            );
            const newVersion = (maxVersion?.max_version || 0) + 1;
            
            // Create new survey version
            const newSurveyResult = await runAsync(
                `INSERT INTO surveys (version, base_survey_id, parent_survey_id, name, description, 
                 languages, eligibility_script, coupon_count_script, eligibility_message_json, is_active, is_draft)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [newVersion, baseId, surveyId, 
                 name || oldSurvey.name,
                 description !== undefined ? description : oldSurvey.description,
                 languages || oldSurvey.languages,
                 eligibility_script !== undefined ? eligibility_script : oldSurvey.eligibility_script,
                 coupon_count_script !== undefined ? coupon_count_script : oldSurvey.coupon_count_script,
                 eligibility_message_json !== undefined ? 
                    (typeof eligibility_message_json === 'object' ? 
                        JSON.stringify(eligibility_message_json) : eligibility_message_json) 
                    : oldSurvey.eligibility_message_json,
                 0, 0]  // not active, not draft
            );
            
            const newSurveyId = newSurveyResult.id;
            
            // Copy all sections, questions, and options to the new version
            const sections = await allAsync('SELECT * FROM sections WHERE survey_id = ?', [surveyId]);
            const sectionMapping = {};
            
            for (const section of sections) {
                const sectionResult = await runAsync(
                    `INSERT INTO sections (survey_id, section_index, section_type, name, description)
                     VALUES (?, ?, ?, ?, ?)`,
                    [newSurveyId, section.section_index, section.section_type, section.name, section.description]
                );
                sectionMapping[section.id] = sectionResult.id;
            }
            
            const questions = await allAsync('SELECT * FROM questions WHERE survey_id = ?', [surveyId]);
            
            for (const question of questions) {
                const newSectionId = sectionMapping[question.section_id];
                const questionResult = await runAsync(
                    `INSERT INTO questions (survey_id, question_index, short_name, question_text_json,
                     audio_files_json, question_type, validation_script, validation_error_json, pre_script, section_id,
                     min_selections, max_selections, skip_to_script, skip_to_target)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [newSurveyId, question.question_index, question.short_name, question.question_text_json,
                     question.audio_files_json, question.question_type, question.validation_script,
                     question.validation_error_json, question.pre_script, newSectionId,
                     question.min_selections, question.max_selections, question.skip_to_script, question.skip_to_target]
                );
                
                const options = await allAsync('SELECT * FROM options WHERE question_id = ?', [question.id]);
                for (const option of options) {
                    await runAsync(
                        `INSERT INTO options (question_id, option_index, option_text_json, audio_files_json, option_value)
                         VALUES (?, ?, ?, ?, ?)`,
                        [questionResult.id, option.option_index, option.option_text_json,
                         option.audio_files_json, option.option_value]
                    );
                }
            }
            
            await logAudit(
                req.session.userId,
                'CREATE_SURVEY_VERSION',
                'survey',
                newSurveyId,
                oldSurvey,
                { version: newVersion, changes: req.body }
            );
            
            res.json({ 
                message: 'New survey version created successfully',
                newSurveyId: newSurveyId,
                version: newVersion
            });
            
        } else {
            // Update the existing survey (for drafts or when create_version is false)
            const updates = [];
            const params = [];
            
            if (name !== undefined) {
                updates.push('name = ?');
                params.push(name);
            }
            if (description !== undefined) {
                updates.push('description = ?');
                params.push(description);
            }
            if (languages !== undefined) {
                updates.push('languages = ?');
                params.push(languages);
            }
            if (eligibility_script !== undefined) {
                updates.push('eligibility_script = ?');
                params.push(eligibility_script);
            }
            if (coupon_count_script !== undefined) {
                updates.push('coupon_count_script = ?');
                params.push(coupon_count_script);
            }
            if (eligibility_message_json !== undefined) {
                updates.push('eligibility_message_json = ?');
                params.push(typeof eligibility_message_json === 'object' ? 
                    JSON.stringify(eligibility_message_json) : eligibility_message_json);
            }
            if (fingerprint_enabled !== undefined) {
                updates.push('fingerprint_enabled = ?');
                params.push(fingerprint_enabled);
            }
            if (req.body.hiv_rapid_test_enabled !== undefined) {
                updates.push('hiv_rapid_test_enabled = ?');
                params.push(req.body.hiv_rapid_test_enabled ? 1 : 0);
            }
            if (re_enrollment_days !== undefined) {
                updates.push('re_enrollment_days = ?');
                params.push(re_enrollment_days);
            }
            if (staff_validation_message_json !== undefined) {
                updates.push('staff_validation_message_json = ?');
                params.push(typeof staff_validation_message_json === 'object' ?
                    JSON.stringify(staff_validation_message_json) : staff_validation_message_json);
            }
            if (contact_info_enabled !== undefined) {
                updates.push('contact_info_enabled = ?');
                params.push(contact_info_enabled);
            }
            if (staff_eligibility_screening !== undefined) {
                updates.push('staff_eligibility_screening = ?');
                params.push(staff_eligibility_screening);
            }
            if (rapid_test_samples_after_eligibility !== undefined) {
                updates.push('rapid_test_samples_after_eligibility = ?');
                params.push(rapid_test_samples_after_eligibility);
            }
            if (payment_audit_phone_enabled !== undefined) {
                updates.push('payment_audit_phone_enabled = ?');
                params.push(payment_audit_phone_enabled);
            }

            if (updates.length > 0) {
                updates.push('updated_at = CURRENT_TIMESTAMP');
                params.push(surveyId);
                
                const sql = `UPDATE surveys SET ${updates.join(', ')} WHERE id = ?`;
                console.log('Executing SQL:', sql);
                console.log('With params:', params);
                
                await runAsync(sql, params);
            }
            
            await logAudit(
                req.session.userId,
                'UPDATE_SURVEY',
                'survey',
                surveyId,
                oldSurvey,
                { name, description, languages }
            );
            
            res.json({ message: 'Survey updated successfully' });
        }
    } catch (error) {
        console.error('Error updating survey:', error);
        res.status(500).json({ error: 'Failed to update survey' });
    }
});

// Add question with multi-language support
router.post('/:surveyId/questions', [
    body('question_index').isInt(),
    body('short_name').notEmpty().trim()
        .matches(/^[a-zA-Z_][a-zA-Z0-9_]*$/).withMessage('Short name must start with a letter or underscore, and contain only letters, numbers, and underscores')
        .custom((v) => {
            // `value` is reserved — it is the JEXL variable bound to the
            // current answer in validation and skip-to scripts.
            // `facility_coupons` is reserved — it is the facility's coupon
            // ceiling, bound in the coupon_count_script context.
            if (v === 'value') throw new Error('"value" is a reserved name and cannot be used as a short name');
            if (v === 'facility_coupons') throw new Error('"facility_coupons" is a reserved name and cannot be used as a short name');
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
    const {
        question_index, short_name, question_text_json, audio_files_json,
        question_type, validation_script, validation_error_json, pre_script,
        section_id, options = [], min_selections, max_selections,
        skip_to_script, skip_to_target
    } = req.body;
    
    try {
        // Check survey exists
        const survey = await getAsync(
            'SELECT * FROM surveys WHERE id = ?',
            [surveyId]
        );
        
        if (!survey) {
            return res.status(404).json({ error: 'Survey not found' });
        }
        
        // If no section_id provided, default to the survey's "main" section
        // (falling back to the lowest-index section). The non-eligibility body
        // section is 'main' — there is no 'survey' section_type.
        let finalSectionId = section_id;
        if (!finalSectionId) {
            const defaultSection = await getAsync(
                `SELECT id FROM sections WHERE survey_id = ?
                 ORDER BY (section_type = 'main') DESC, section_index ASC LIMIT 1`,
                [surveyId]
            );
            finalSectionId = defaultSection ? defaultSection.id : null;
        }
        
        // Insert question
        const questionResult = await runAsync(
            `INSERT INTO questions (survey_id, question_index, short_name, question_text_json,
             audio_files_json, question_type, validation_script, validation_error_json, pre_script, section_id,
             min_selections, max_selections, skip_to_script, skip_to_target)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [surveyId, question_index, short_name, JSON.stringify(question_text_json),
             JSON.stringify(audio_files_json || {}), question_type, validation_script,
             JSON.stringify(validation_error_json || {"English": "Invalid answer"}), pre_script, finalSectionId,
             min_selections || null, max_selections || null, skip_to_script || null, skip_to_target || null]
        );
        
        const questionId = questionResult.id;
        
        // Insert options if provided
        for (const option of options) {
            await runAsync(
                `INSERT INTO options (question_id, option_index, option_text_json, audio_files_json, option_value)
                 VALUES (?, ?, ?, ?, ?)`,
                [questionId, option.option_index || 0,
                 JSON.stringify(option.text_json || {}),
                 JSON.stringify(option.audio_json || {}),
                 option.value || JSON.stringify(option.text_json)]
            );
        }
        
        await logAudit(
            req.session.userId,
            'ADD_QUESTION',
            'question',
            questionId,
            null,
            { surveyId, short_name, question_text_json }
        );
        
        res.status(201).json({
            id: questionId,
            message: 'Question added successfully'
        });
    } catch (error) {
        console.error('Error adding question:', error);
        res.status(500).json({ error: 'Failed to add question' });
    }
});

// Update question with multi-language support
router.put('/:surveyId/questions/:questionId', [
    body('question_index').optional().isInt(),
    body('short_name').optional().trim()
        .matches(/^[a-zA-Z_][a-zA-Z0-9_]*$/).withMessage('Short name must start with a letter or underscore, and contain only letters, numbers, and underscores')
        .custom((v) => {
            // `value` is reserved — it is the JEXL variable bound to the
            // current answer in validation and skip-to scripts.
            // `facility_coupons` is reserved — it is the facility's coupon
            // ceiling, bound in the coupon_count_script context.
            if (v === 'value') throw new Error('"value" is a reserved name and cannot be used as a short name');
            if (v === 'facility_coupons') throw new Error('"facility_coupons" is a reserved name and cannot be used as a short name');
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
    const {
        question_index, short_name, question_text_json, audio_files_json,
        question_type, validation_script, validation_error_json, pre_script, section_id, options,
        min_selections, max_selections, skip_to_script, skip_to_target
    } = req.body;
    
    try {
        // Check question exists
        const question = await getAsync(
            'SELECT * FROM questions WHERE id = ? AND survey_id = ?',
            [questionId, surveyId]
        );
        
        if (!question) {
            return res.status(404).json({ error: 'Question not found' });
        }
        
        // Build update query
        const updates = [];
        const params = [];
        
        if (question_index !== undefined) {
            updates.push('question_index = ?');
            params.push(question_index);
        }
        if (short_name !== undefined) {
            updates.push('short_name = ?');
            params.push(short_name);
        }
        if (question_text_json !== undefined) {
            updates.push('question_text_json = ?');
            params.push(JSON.stringify(question_text_json));
        }
        if (audio_files_json !== undefined) {
            updates.push('audio_files_json = ?');
            params.push(JSON.stringify(audio_files_json));
        }
        if (question_type !== undefined) {
            updates.push('question_type = ?');
            params.push(question_type);
        }
        if (validation_script !== undefined) {
            updates.push('validation_script = ?');
            params.push(validation_script);
        }
        if (validation_error_json !== undefined) {
            updates.push('validation_error_json = ?');
            params.push(JSON.stringify(validation_error_json));
        }
        if (pre_script !== undefined) {
            updates.push('pre_script = ?');
            params.push(pre_script);
        }
        if (section_id !== undefined) {
            updates.push('section_id = ?');
            params.push(section_id);
        }
        if (min_selections !== undefined) {
            updates.push('min_selections = ?');
            params.push(min_selections);
        }
        if (max_selections !== undefined) {
            updates.push('max_selections = ?');
            params.push(max_selections);
        }
        if (skip_to_script !== undefined) {
            updates.push('skip_to_script = ?');
            params.push(skip_to_script);
        }
        if (skip_to_target !== undefined) {
            updates.push('skip_to_target = ?');
            params.push(skip_to_target);
        }

        if (updates.length > 0) {
            params.push(questionId);
            await runAsync(
                `UPDATE questions SET ${updates.join(', ')} WHERE id = ?`,
                params
            );
        }
        
        // Update options if provided
        if (options !== undefined) {
            // Delete existing options
            await runAsync('DELETE FROM options WHERE question_id = ?', [questionId]);
            
            // Insert new options
            for (const option of options) {
                await runAsync(
                    `INSERT INTO options (question_id, option_index, option_text_json, audio_files_json, option_value)
                     VALUES (?, ?, ?, ?, ?)`,
                    [questionId, option.option_index || 0,
                     JSON.stringify(option.text_json || {}),
                     JSON.stringify(option.audio_json || {}),
                     option.value || JSON.stringify(option.text_json)]
                );
            }
        }
        
        await logAudit(
            req.session.userId,
            'UPDATE_QUESTION',
            'question',
            questionId,
            question,
            req.body
        );
        
        res.json({ message: 'Question updated successfully' });
    } catch (error) {
        console.error('Error updating question:', error);
        res.status(500).json({ error: 'Failed to update question' });
    }
});

// Delete question
router.delete('/:surveyId/questions/:questionId', async (req, res) => {
    const { surveyId, questionId } = req.params;
    
    try {
        const question = await getAsync(
            'SELECT * FROM questions WHERE id = ? AND survey_id = ?',
            [questionId, surveyId]
        );
        
        if (!question) {
            return res.status(404).json({ error: 'Question not found' });
        }
        
        // Delete options first
        await runAsync('DELETE FROM options WHERE question_id = ?', [questionId]);
        
        // Delete question
        await runAsync('DELETE FROM questions WHERE id = ?', [questionId]);
        
        await logAudit(
            req.session.userId,
            'DELETE_QUESTION',
            'question',
            questionId,
            question,
            null
        );
        
        res.json({ message: 'Question deleted successfully' });
    } catch (error) {
        console.error('Error deleting question:', error);
        res.status(500).json({ error: 'Failed to delete question' });
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
        for (let i = 0; i < questionOrder.length; i++) {
            await runAsync(
                'UPDATE questions SET question_index = ? WHERE id = ? AND survey_id = ?',
                [i, questionOrder[i], surveyId]
            );
        }
        
        await logAudit(
            req.session.userId,
            'REORDER_QUESTIONS',
            'survey',
            surveyId,
            null,
            { questionOrder }
        );
        
        res.json({ message: 'Questions reordered successfully' });
    } catch (error) {
        console.error('Error reordering questions:', error);
        res.status(500).json({ error: 'Failed to reorder questions' });
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
    
    try {
        // New surveys always start at version 1
        const newVersion = 1;
        
        // Get settings from base survey if cloning
        let surveyLanguages = languages || '["en"]';
        let eligibilityScript = 'consent == "1" && age >= 18 && age <= 65';
        let eligibilityMessageJson = null;
        let fingerprintEnabled = 0;
        let reEnrollmentDays = 90;
        let staffValidationMessageJson = null;
        let hivRapidTestEnabled = 1;
        let couponCountScript = null;

        if (basedOnSurveyId) {
            const baseSurvey = await getAsync(
                `SELECT languages, eligibility_script, coupon_count_script, eligibility_message_json,
                        fingerprint_enabled, re_enrollment_days, staff_validation_message_json,
                        hiv_rapid_test_enabled
                 FROM surveys WHERE id = ?`,
                [basedOnSurveyId]
            );
            if (baseSurvey) {
                // Copy all settings from base survey
                if (!languages && baseSurvey.languages) {
                    surveyLanguages = baseSurvey.languages;
                }
                if (baseSurvey.eligibility_script) {
                    eligibilityScript = baseSurvey.eligibility_script;
                }
                if (baseSurvey.coupon_count_script) {
                    couponCountScript = baseSurvey.coupon_count_script;
                }
                if (baseSurvey.eligibility_message_json) {
                    eligibilityMessageJson = baseSurvey.eligibility_message_json;
                }
                if (baseSurvey.fingerprint_enabled !== null) {
                    fingerprintEnabled = baseSurvey.fingerprint_enabled;
                }
                if (baseSurvey.re_enrollment_days !== null) {
                    reEnrollmentDays = baseSurvey.re_enrollment_days;
                }
                if (baseSurvey.staff_validation_message_json) {
                    staffValidationMessageJson = baseSurvey.staff_validation_message_json;
                }
                if (baseSurvey.hiv_rapid_test_enabled !== null) {
                    hivRapidTestEnabled = baseSurvey.hiv_rapid_test_enabled;
                }
            }
        }

        // Create new survey with settings from base survey or defaults
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
        const eligibilitySection = await runAsync(
            `INSERT INTO sections (survey_id, section_index, section_type, name, description) 
             VALUES (?, ?, ?, ?, ?)`,
            [newSurveyId, 0, 'eligibility', 'Eligibility', 'Screening questions to determine eligibility']
        );
        
        const mainSection = await runAsync(
            `INSERT INTO sections (survey_id, section_index, section_type, name, description) 
             VALUES (?, ?, ?, ?, ?)`,
            [newSurveyId, 1, 'main', 'Main', 'Primary survey questions']
        );
        
        // If based on existing survey, copy sections, questions and options
        if (basedOnSurveyId) {
            // Copy additional sections if they exist (beyond the default two)
            const baseSections = await allAsync(
                'SELECT * FROM sections WHERE survey_id = ? AND section_type NOT IN (?, ?) ORDER BY section_index',
                [basedOnSurveyId, 'eligibility', 'main']
            );
            
            const sectionMapping = {};
            for (const section of baseSections) {
                const newSectionResult = await runAsync(
                    `INSERT INTO sections (survey_id, section_index, section_type, name, description) 
                     VALUES (?, ?, ?, ?, ?)`,
                    [newSurveyId, section.section_index + 2, section.section_type, section.name, section.description]
                );
                sectionMapping[section.id] = newSectionResult.id;
            }
            
            // Map the default sections
            const baseEligibility = await getAsync(
                'SELECT id FROM sections WHERE survey_id = ? AND section_type = ?',
                [basedOnSurveyId, 'eligibility']
            );
            const baseMain = await getAsync(
                'SELECT id FROM sections WHERE survey_id = ? AND section_type = ?',
                [basedOnSurveyId, 'main']
            );
            
            if (baseEligibility) sectionMapping[baseEligibility.id] = eligibilitySection.id;
            if (baseMain) sectionMapping[baseMain.id] = mainSection.id;
            const questions = await allAsync(
                'SELECT * FROM questions WHERE survey_id = ?',
                [basedOnSurveyId]
            );
            
            for (const question of questions) {
                // Map the section_id to the new survey's sections
                const newSectionId = sectionMapping[question.section_id] || mainSection.id;
                
                const questionResult = await runAsync(
                    `INSERT INTO questions (survey_id, question_index, short_name, question_text_json, 
                     audio_files_json, question_type, validation_script, validation_error_json, pre_script, section_id)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [newSurveyId, question.question_index, question.short_name, 
                     question.question_text_json, question.audio_files_json,
                     question.question_type, question.validation_script, 
                     question.validation_error_json, question.pre_script, newSectionId]
                );
                
                // Copy options for this question
                const options = await allAsync(
                    'SELECT * FROM options WHERE question_id = ?',
                    [question.id]
                );
                
                for (const option of options) {
                    await runAsync(
                        `INSERT INTO options (question_id, option_index, option_text_json, audio_files_json, option_value)
                         VALUES (?, ?, ?, ?, ?)`,
                        [questionResult.id, option.option_index, option.option_text_json, 
                         option.audio_files_json, option.option_value]
                    );
                }
            }

            // Copy system messages
            const systemMessages = await allAsync(
                'SELECT * FROM survey_messages WHERE survey_id = ?',
                [basedOnSurveyId]
            );

            for (const message of systemMessages) {
                await runAsync(
                    `INSERT INTO survey_messages (survey_id, message_key, display_order,
                     message_text_json, audio_files_json, message_type)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [newSurveyId, message.message_key, message.display_order,
                     message.message_text_json, message.audio_files_json, message.message_type]
                );
            }
        }

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
        
        res.json({ message: 'Survey activated successfully' });
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