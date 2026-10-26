const express = require('express');
const { getAsync, allAsync, runAsync } = require('../../models/database');
const { requireAdmin } = require('../../middleware/auth');
const router = express.Router();

/**
 * Get all test configurations for a survey
 * GET /api/admin/survey-config/:surveyId/tests
 */
router.get('/survey-config/:surveyId/tests', requireAdmin, async (req, res) => {
    try {
        const { surveyId } = req.params;

        // Verify survey exists
        const survey = await getAsync(
            'SELECT id, name FROM surveys WHERE id = ?',
            [surveyId]
        );

        if (!survey) {
            return res.status(404).json({
                status: 'error',
                message: 'Survey not found'
            });
        }

        // Get all test configurations
        const tests = await allAsync(
            `SELECT id, test_id, test_name, enabled, display_order
             FROM test_configurations
             WHERE survey_id = ?
             ORDER BY display_order`,
            [surveyId]
        );

        res.json({
            status: 'success',
            data: {
                survey_id: surveyId,
                survey_name: survey.name,
                tests: tests
            }
        });

    } catch (error) {
        console.error('Error fetching test configurations:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to fetch test configurations'
        });
    }
});

/**
 * Update a test configuration (enable/disable or update properties)
 * PUT /api/admin/survey-config/:surveyId/tests/:testId
 */
router.put('/survey-config/:surveyId/tests/:testId', requireAdmin, async (req, res) => {
    try {
        const { surveyId, testId } = req.params;
        const { enabled, display_order, test_name } = req.body;

        // Verify survey exists
        const survey = await getAsync(
            'SELECT id FROM surveys WHERE id = ?',
            [surveyId]
        );

        if (!survey) {
            return res.status(404).json({
                status: 'error',
                message: 'Survey not found'
            });
        }

        // Check if test configuration exists
        const existingTest = await getAsync(
            'SELECT id FROM test_configurations WHERE survey_id = ? AND test_id = ?',
            [surveyId, testId]
        );

        if (!existingTest) {
            return res.status(404).json({
                status: 'error',
                message: 'Test configuration not found'
            });
        }

        // Build update query dynamically based on provided fields
        const updates = [];
        const values = [];

        if (enabled !== undefined) {
            updates.push('enabled = ?');
            values.push(enabled ? 1 : 0);
        }

        if (display_order !== undefined) {
            updates.push('display_order = ?');
            values.push(display_order);
        }

        if (test_name !== undefined) {
            updates.push('test_name = ?');
            values.push(test_name);
        }

        if (updates.length === 0) {
            return res.status(400).json({
                status: 'error',
                message: 'No fields to update'
            });
        }

        // Add WHERE clause values
        values.push(surveyId, testId);

        // Execute update
        await runAsync(
            `UPDATE test_configurations
             SET ${updates.join(', ')}
             WHERE survey_id = ? AND test_id = ?`,
            values
        );

        // Fetch updated test configuration
        const updatedTest = await getAsync(
            'SELECT * FROM test_configurations WHERE survey_id = ? AND test_id = ?',
            [surveyId, testId]
        );

        res.json({
            status: 'success',
            message: 'Test configuration updated',
            data: updatedTest
        });

    } catch (error) {
        console.error('Error updating test configuration:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to update test configuration'
        });
    }
});

/**
 * Update display order for multiple tests
 * PUT /api/admin/survey-config/:surveyId/tests/order
 */
router.put('/survey-config/:surveyId/tests-order', requireAdmin, async (req, res) => {
    try {
        const { surveyId } = req.params;
        const { test_order } = req.body; // Array of {test_id, display_order}

        if (!Array.isArray(test_order)) {
            return res.status(400).json({
                status: 'error',
                message: 'test_order must be an array'
            });
        }

        // Verify survey exists
        const survey = await getAsync(
            'SELECT id FROM surveys WHERE id = ?',
            [surveyId]
        );

        if (!survey) {
            return res.status(404).json({
                status: 'error',
                message: 'Survey not found'
            });
        }

        // Update each test's display order
        for (const item of test_order) {
            await runAsync(
                `UPDATE test_configurations
                 SET display_order = ?
                 WHERE survey_id = ? AND test_id = ?`,
                [item.display_order, surveyId, item.test_id]
            );
        }

        // Fetch updated configurations
        const tests = await allAsync(
            `SELECT * FROM test_configurations
             WHERE survey_id = ?
             ORDER BY display_order`,
            [surveyId]
        );

        res.json({
            status: 'success',
            message: 'Display order updated',
            data: tests
        });

    } catch (error) {
        console.error('Error updating test order:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to update test order'
        });
    }
});

/**
 * Create a new test configuration
 * POST /api/admin/survey-config/:surveyId/tests
 */
router.post('/survey-config/:surveyId/tests', requireAdmin, async (req, res) => {
    try {
        const { surveyId } = req.params;
        const { test_id, test_name, enabled, display_order } = req.body;

        // Validate required fields
        if (!test_id || !test_name) {
            return res.status(400).json({
                status: 'error',
                message: 'test_id and test_name are required'
            });
        }

        // Verify survey exists
        const survey = await getAsync(
            'SELECT id FROM surveys WHERE id = ?',
            [surveyId]
        );

        if (!survey) {
            return res.status(404).json({
                status: 'error',
                message: 'Survey not found'
            });
        }

        // Check if test already exists
        const existingTest = await getAsync(
            'SELECT id FROM test_configurations WHERE survey_id = ? AND test_id = ?',
            [surveyId, test_id]
        );

        if (existingTest) {
            return res.status(409).json({
                status: 'error',
                message: 'Test configuration already exists'
            });
        }

        // Get max display_order if not provided
        let orderValue = display_order;
        if (orderValue === undefined) {
            const maxOrder = await getAsync(
                'SELECT MAX(display_order) as max_order FROM test_configurations WHERE survey_id = ?',
                [surveyId]
            );
            orderValue = (maxOrder?.max_order || 0) + 1;
        }

        // Insert new test configuration
        const result = await runAsync(
            `INSERT INTO test_configurations (survey_id, test_id, test_name, enabled, display_order)
             VALUES (?, ?, ?, ?, ?)`,
            [surveyId, test_id, test_name, enabled ? 1 : 0, orderValue]
        );

        // Fetch created test
        const createdTest = await getAsync(
            'SELECT * FROM test_configurations WHERE id = ?',
            [result.lastID]
        );

        res.json({
            status: 'success',
            message: 'Test configuration created',
            data: createdTest
        });

    } catch (error) {
        console.error('Error creating test configuration:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to create test configuration'
        });
    }
});

/**
 * Delete a test configuration
 * DELETE /api/admin/survey-config/:surveyId/tests/:testId
 */
router.delete('/survey-config/:surveyId/tests/:testId', requireAdmin, async (req, res) => {
    try {
        const { surveyId, testId } = req.params;

        // Check if test configuration exists
        const existingTest = await getAsync(
            'SELECT id FROM test_configurations WHERE survey_id = ? AND test_id = ?',
            [surveyId, testId]
        );

        if (!existingTest) {
            return res.status(404).json({
                status: 'error',
                message: 'Test configuration not found'
            });
        }

        // Delete test configuration
        await runAsync(
            'DELETE FROM test_configurations WHERE survey_id = ? AND test_id = ?',
            [surveyId, testId]
        );

        res.json({
            status: 'success',
            message: 'Test configuration deleted'
        });

    } catch (error) {
        console.error('Error deleting test configuration:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to delete test configuration'
        });
    }
});

module.exports = router;
