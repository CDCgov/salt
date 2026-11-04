const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { getAsync, allAsync, runAsync } = require('../../models/database');
const { requireAdmin, requireStaffOrAdmin } = require('../../middleware/auth');
const labEditing = require('../../services/labTestEditing');
const { labConditionReport } = labEditing;
const { EditError } = require('../../services/surveyEditing');


// Get all lab tests (admin only)
router.get('/lab-tests', requireAdmin, async (req, res) => {
    try {
        const { active } = req.query;

        let query = 'SELECT * FROM lab_test_configurations WHERE 1=1';
        const params = [];

        if (active !== undefined) {
            query += ' AND is_active = ?';
            params.push(active === 'true' ? 1 : 0);
        }

        query += ' ORDER BY display_order ASC, test_name ASC';

        const tests = await allAsync(query, params);

        // Parse options JSON for dropdown tests
        const enhancedTests = tests.map(test => ({
            ...test,
            options: test.options ? JSON.parse(test.options) : null
        }));

        res.json({
            success: true,
            tests: enhancedTests,
            total: enhancedTests.length
        });
    } catch (error) {
        console.error('Error fetching lab tests:', error);
        res.status(500).json({ error: 'Failed to fetch lab tests' });
    }
});

// Get active lab tests (for lab staff)
router.get('/lab-tests/active', requireStaffOrAdmin, async (req, res) => {
    try {
        const tests = await allAsync(
            'SELECT * FROM lab_test_configurations WHERE is_active = 1 ORDER BY display_order ASC, test_name ASC'
        );

        const enhancedTests = tests.map(test => ({
            ...test,
            options: test.options ? JSON.parse(test.options) : null
        }));

        res.json({
            success: true,
            tests: enhancedTests
        });
    } catch (error) {
        console.error('Error fetching active lab tests:', error);
        res.status(500).json({ error: 'Failed to fetch active lab tests' });
    }
});

// Get single lab test
router.get('/lab-tests/:id', requireAdmin, async (req, res) => {
    try {
        const testId = parseInt(req.params.id);

        const test = await getAsync(
            'SELECT * FROM lab_test_configurations WHERE id = ?',
            [testId]
        );

        if (!test) {
            return res.status(404).json({ error: 'Lab test not found' });
        }

        res.json({
            success: true,
            test: {
                ...test,
                options: test.options ? JSON.parse(test.options) : null
            }
        });
    } catch (error) {
        console.error('Error fetching lab test:', error);
        res.status(500).json({ error: 'Failed to fetch lab test' });
    }
});

// Create new lab test (admin only)
router.post('/lab-tests',
    requireAdmin,
    [
        body('test_name')
            .trim()
            .notEmpty()
            .withMessage('Test name is required'),
        body('test_code')
            .optional()
            .trim()
            .isAlphanumeric()
            .withMessage('Test code must be alphanumeric'),
        body('test_type')
            .isIn(['dropdown', 'numeric'])
            .withMessage('Test type must be dropdown or numeric'),
        body('options')
            .if(body('test_type').equals('dropdown'))
            .isArray({ min: 2 })
            .withMessage('Dropdown tests must have at least 2 options'),
        body('min_value')
            .if(body('test_type').equals('numeric'))
            .optional()
            .isNumeric()
            .withMessage('Min value must be numeric'),
        body('max_value')
            .if(body('test_type').equals('numeric'))
            .optional()
            .isNumeric()
            .withMessage('Max value must be numeric')
            .custom((value, { req }) => {
                if (req.body.min_value !== undefined && value !== undefined) {
                    return parseFloat(value) > parseFloat(req.body.min_value);
                }
                return true;
            })
            .withMessage('Max value must be greater than min value'),
        body('unit')
            .if(body('test_type').equals('numeric'))
            .optional()
            .trim(),
        body('display_order')
            .optional()
            .isInt()
            .withMessage('Display order must be an integer'),
        body('jexl_condition')
            .optional()
            .trim()
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        try {
            const result = await labEditing.createLabTest(req.body, { userId: req.session && req.session.userId, via: 'web' });
            res.status(201).json({
                success: true,
                message: 'Lab test created successfully',
                testId: result.id,
                jexl_check: await labConditionReport(result.id)
            });
        } catch (error) {
            if (error instanceof EditError) return res.status(error.status).json({ error: error.message });
            console.error('Error creating lab test:', error);
            res.status(500).json({ error: 'Failed to create lab test' });
        }
    }
);

// Update lab test (admin only)
router.put('/lab-tests/:id',
    requireAdmin,
    [
        body('test_name')
            .optional()
            .trim()
            .notEmpty()
            .withMessage('Test name cannot be empty'),
        body('test_code')
            .optional()
            .trim()
            .isAlphanumeric()
            .withMessage('Test code must be alphanumeric'),
        body('options')
            .optional()
            .isArray({ min: 2 })
            .withMessage('Dropdown tests must have at least 2 options'),
        body('min_value')
            .optional()
            .isNumeric()
            .withMessage('Min value must be numeric'),
        body('max_value')
            .optional()
            .isNumeric()
            .withMessage('Max value must be numeric'),
        body('is_active')
            .optional()
            .isBoolean()
            .withMessage('Active status must be boolean'),
        body('jexl_condition')
            .optional()
            .trim()
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        try {
            const testId = parseInt(req.params.id);
            await labEditing.updateLabTest(testId, req.body, { userId: req.session && req.session.userId, via: 'web' });
            res.json({
                success: true,
                message: 'Lab test updated successfully',
                jexl_check: await labConditionReport(testId)
            });
        } catch (error) {
            if (error instanceof EditError) return res.status(error.status).json({ error: error.message });
            console.error('Error updating lab test:', error);
            res.status(500).json({ error: 'Failed to update lab test' });
        }
    }
);

// Delete (deactivate) lab test (admin only)
router.delete('/lab-tests/:id', requireAdmin, async (req, res) => {
    try {
        const testId = parseInt(req.params.id);

        // Check if test exists
        const existing = await getAsync(
            'SELECT * FROM lab_test_configurations WHERE id = ?',
            [testId]
        );

        if (!existing) {
            return res.status(404).json({ error: 'Lab test not found' });
        }

        // Check if there are any results for this test
        const hasResults = await getAsync(
            'SELECT COUNT(*) as count FROM lab_results WHERE test_id = ?',
            [testId]
        );

        if (hasResults.count > 0) {
            // If there are results, just deactivate
            await runAsync(
                'UPDATE lab_test_configurations SET is_active = 0 WHERE id = ?',
                [testId]
            );

            res.json({
                success: true,
                message: 'Lab test deactivated (has existing results)'
            });
        } else {
            // If no results, we can actually delete it
            await runAsync(
                'DELETE FROM lab_test_configurations WHERE id = ?',
                [testId]
            );

            res.json({
                success: true,
                message: 'Lab test deleted successfully'
            });
        }
    } catch (error) {
        console.error('Error deleting lab test:', error);
        res.status(500).json({ error: 'Failed to delete lab test' });
    }
});

module.exports = router;