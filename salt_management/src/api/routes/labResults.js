const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { getAsync, allAsync, runAsync } = require('../../models/database');
const { requireStaffOrAdmin } = require('../../middleware/auth');
const fs = require('fs').promises;
const path = require('path');
const { isSafeId, safeJoin } = require('../../utils/safeIds');

// Validate subject ID exists in completed surveys
router.get('/lab-results/validate-subject/:subjectId', requireStaffOrAdmin, async (req, res) => {
    try {
        const { subjectId } = req.params;

        // Check if subject exists in completed_surveys
        const subject = await getAsync(
            `SELECT id, participant_id, completed_at, facility_id
             FROM completed_surveys
             WHERE participant_id = ?
             ORDER BY completed_at DESC
             LIMIT 1`,
            [subjectId]
        );

        if (!subject) {
            return res.json({
                valid: false,
                error: 'Subject ID not found. Please ensure the participant has completed a survey first.'
            });
        }

        // Get any existing lab results for this subject
        const existingResults = await allAsync(
            `SELECT lr.*, ltc.test_name, ltc.test_type
             FROM lab_results lr
             JOIN lab_test_configurations ltc ON lr.test_id = ltc.id
             WHERE lr.subject_id = ?
             ORDER BY lr.created_at DESC`,
            [subjectId]
        );

        res.json({
            valid: true,
            surveyCompleted: subject.completed_at,
            existingResults: existingResults
        });
    } catch (error) {
        console.error('Error validating subject:', error);
        res.status(500).json({ error: 'Failed to validate subject ID' });
    }
});

// Submit lab results
router.post('/lab-results',
    requireStaffOrAdmin,
    [
        body('subject_id')
            .trim()
            .notEmpty()
            .withMessage('Subject ID is required')
            .custom(isSafeId)
            .withMessage('Subject ID may only contain letters, numbers, "-" and "_"'),
        body('results')
            .isArray({ min: 1 })
            .withMessage('At least one test result is required'),
        body('results.*.test_id')
            .isInt()
            .withMessage('Valid test ID is required'),
        body('results.*.value')
            .notEmpty()
            .withMessage('Test result value is required')
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        try {
            const { subject_id, results } = req.body;
            const submitted_by = req.session.userId;

            // Skip subject validation for now

            // Prepare JSON data
            const jsonData = {
                subject_id,
                submitted_by,
                submitted_at: new Date().toISOString(),
                results: []
            };

            // Process each test result
            for (const result of results) {
                // Get test configuration
                const testConfig = await getAsync(
                    'SELECT * FROM lab_test_configurations WHERE id = ? AND is_active = 1',
                    [result.test_id]
                );

                if (!testConfig) {
                    return res.status(400).json({
                        error: `Test ID ${result.test_id} is invalid or inactive`
                    });
                }

                let result_value = null;
                let result_numeric = null;

                if (testConfig.test_type === 'numeric') {
                    result_numeric = parseFloat(result.value);

                    // Validate bounds if specified
                    if (testConfig.min_value !== null && result_numeric < testConfig.min_value) {
                        return res.status(400).json({
                            error: `${testConfig.test_name} value must be at least ${testConfig.min_value}`
                        });
                    }

                    if (testConfig.max_value !== null && result_numeric > testConfig.max_value) {
                        return res.status(400).json({
                            error: `${testConfig.test_name} value must not exceed ${testConfig.max_value}`
                        });
                    }
                } else if (testConfig.test_type === 'dropdown') {
                    result_value = result.value;

                    // Validate option exists
                    const options = JSON.parse(testConfig.options || '[]');
                    if (!options.includes(result.value)) {
                        return res.status(400).json({
                            error: `Invalid option for ${testConfig.test_name}`
                        });
                    }
                }

                // Add to JSON data
                jsonData.results.push({
                    test_id: testConfig.id,
                    test_name: testConfig.test_name,
                    test_type: testConfig.test_type,
                    value: testConfig.test_type === 'numeric' ? result_numeric : result_value,
                    unit: testConfig.unit || null,
                    entered_at: new Date().toISOString()
                });
            }

            // Create JSON file
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const fileName = `${subject_id}_${timestamp}.json`;
            const dirPath = path.join(__dirname, '../../..', 'data', 'uploads', 'labs');
            const filePath = safeJoin(dirPath, fileName);

            // Ensure directory exists
            await fs.mkdir(dirPath, { recursive: true });

            // Write JSON file
            await fs.writeFile(filePath, JSON.stringify(jsonData, null, 2));

            // Store results in database
            for (const result of results) {
                const testConfig = await getAsync(
                    'SELECT test_type FROM lab_test_configurations WHERE id = ?',
                    [result.test_id]
                );

                const insertResult = await runAsync(
                    `INSERT INTO lab_results
                    (subject_id, test_id, result_value, result_numeric, submitted_by, file_path)
                    VALUES (?, ?, ?, ?, ?, ?)`,
                    [
                        subject_id,
                        result.test_id,
                        testConfig.test_type === 'dropdown' ? result.value : null,
                        testConfig.test_type === 'numeric' ? parseFloat(result.value) : null,
                        submitted_by,
                        `labs/${fileName}`
                    ]
                );
            }

            res.json({
                success: true,
                message: 'Lab results submitted successfully',
                file: fileName
            });

        } catch (error) {
            console.error('Error submitting lab results:', error);
            res.status(500).json({ error: 'Failed to submit lab results' });
        }
    }
);

// Get lab results for a subject (admin only)
router.get('/lab-results/subject/:subjectId', requireStaffOrAdmin, async (req, res) => {
    try {
        const { subjectId } = req.params;

        const results = await allAsync(
            `SELECT lr.*, ltc.test_name, ltc.test_type, ltc.unit,
                    u.username as submitted_by_name
             FROM lab_results lr
             JOIN lab_test_configurations ltc ON lr.test_id = ltc.id
             LEFT JOIN admin_users u ON lr.submitted_by = u.id
             WHERE lr.subject_id = ?
             ORDER BY lr.created_at DESC`,
            [subjectId]
        );

        res.json({
            success: true,
            results: results
        });
    } catch (error) {
        console.error('Error fetching lab results:', error);
        res.status(500).json({ error: 'Failed to fetch lab results' });
    }
});

module.exports = router;