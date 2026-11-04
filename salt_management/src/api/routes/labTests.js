const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { getAsync, allAsync, runAsync } = require('../../models/database');
const { requireAdmin, requireStaffOrAdmin } = require('../../middleware/auth');
const database = require('../../models/database');
const { checkLabConditions, loadSurveyData } = require('../../services/jexlCheck');

// Checks a lab test's JEXL condition against the active survey. Saves are
// never blocked; the result is returned with the save response.
async function labConditionReport(testId) {
    try {
        const lab = await getAsync('SELECT id, test_name, jexl_condition FROM lab_test_configurations WHERE id = ?', [testId]);
        if (!lab || !lab.jexl_condition) return { errors: [], warnings: [], checked: true };
        const active = await getAsync('SELECT id FROM surveys WHERE is_active = 1 ORDER BY id DESC LIMIT 1');
        const data = active ? await loadSurveyData(database, active.id) : null;
        return await checkLabConditions([lab], data);
    } catch (err) {
        console.error('Lab condition check failed:', err);
        return null;
    }
}

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
            const {
                test_name,
                test_code,
                test_type,
                options,
                min_value,
                max_value,
                unit,
                description,
                display_order,
                jexl_condition
            } = req.body;

            // Check if test name already exists
            const existing = await getAsync(
                'SELECT id FROM lab_test_configurations WHERE test_name = ?',
                [test_name]
            );

            if (existing) {
                return res.status(409).json({ error: 'Test name already exists' });
            }

            // Check if test code already exists
            if (test_code) {
                const existingCode = await getAsync(
                    'SELECT id FROM lab_test_configurations WHERE test_code = ?',
                    [test_code]
                );

                if (existingCode) {
                    return res.status(409).json({ error: 'Test code already exists' });
                }
            }

            // Prepare values based on test type
            let finalOptions = null;
            let finalMinValue = null;
            let finalMaxValue = null;
            let finalUnit = null;

            if (test_type === 'dropdown') {
                finalOptions = JSON.stringify(options);
            } else if (test_type === 'numeric') {
                finalMinValue = min_value !== undefined ? parseFloat(min_value) : null;
                finalMaxValue = max_value !== undefined ? parseFloat(max_value) : null;
                finalUnit = unit || null;
            }

            const result = await runAsync(
                `INSERT INTO lab_test_configurations
                (test_name, test_code, test_type, options, min_value, max_value, unit, description, display_order, jexl_condition)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    test_name,
                    test_code || null,
                    test_type,
                    finalOptions,
                    finalMinValue,
                    finalMaxValue,
                    finalUnit,
                    description || null,
                    display_order || 0,
                    jexl_condition || null
                ]
            );

            res.status(201).json({
                success: true,
                message: 'Lab test created successfully',
                testId: result.id,
                jexl_check: await labConditionReport(result.id)
            });
        } catch (error) {
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
            const updates = req.body;

            // Check if test exists
            const existing = await getAsync(
                'SELECT * FROM lab_test_configurations WHERE id = ?',
                [testId]
            );

            if (!existing) {
                return res.status(404).json({ error: 'Lab test not found' });
            }

            // Build update query
            const updateFields = [];
            const params = [];

            if (updates.test_name !== undefined) {
                // Check if new name already exists
                const nameExists = await getAsync(
                    'SELECT id FROM lab_test_configurations WHERE test_name = ? AND id != ?',
                    [updates.test_name, testId]
                );
                if (nameExists) {
                    return res.status(409).json({ error: 'Test name already exists' });
                }
                updateFields.push('test_name = ?');
                params.push(updates.test_name);
            }

            if (updates.test_code !== undefined) {
                // Check if new code already exists
                if (updates.test_code) {
                    const codeExists = await getAsync(
                        'SELECT id FROM lab_test_configurations WHERE test_code = ? AND id != ?',
                        [updates.test_code, testId]
                    );
                    if (codeExists) {
                        return res.status(409).json({ error: 'Test code already exists' });
                    }
                }
                updateFields.push('test_code = ?');
                params.push(updates.test_code || null);
            }

            if (updates.options !== undefined) {
                updateFields.push('options = ?');
                params.push(JSON.stringify(updates.options));
            }

            if (updates.min_value !== undefined) {
                updateFields.push('min_value = ?');
                params.push(parseFloat(updates.min_value));
            }

            if (updates.max_value !== undefined) {
                updateFields.push('max_value = ?');
                params.push(parseFloat(updates.max_value));
            }

            if (updates.unit !== undefined) {
                updateFields.push('unit = ?');
                params.push(updates.unit);
            }

            if (updates.description !== undefined) {
                updateFields.push('description = ?');
                params.push(updates.description);
            }

            if (updates.display_order !== undefined) {
                updateFields.push('display_order = ?');
                params.push(updates.display_order);
            }

            if (updates.is_active !== undefined) {
                updateFields.push('is_active = ?');
                params.push(updates.is_active ? 1 : 0);
            }

            if (updates.jexl_condition !== undefined) {
                updateFields.push('jexl_condition = ?');
                params.push(updates.jexl_condition || null);
            }

            if (updateFields.length === 0) {
                return res.status(400).json({ error: 'No valid updates provided' });
            }

            params.push(testId);

            await runAsync(
                `UPDATE lab_test_configurations SET ${updateFields.join(', ')} WHERE id = ?`,
                params
            );

            res.json({
                success: true,
                message: 'Lab test updated successfully',
                jexl_check: await labConditionReport(testId)
            });
        } catch (error) {
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