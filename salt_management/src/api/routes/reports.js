const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../../middleware/auth');
const { allAsync, getAsync, runAsync } = require('../../models/database');
const ReportExecutor = require('../../services/reportExecutor');
const reportScheduler = require('../../services/reportScheduler');
const reportTemplates = require('../../services/reportTemplates');
const path = require('path');
const fs = require('fs').promises;

const reportExecutor = new ReportExecutor();

/**
 * List example report templates (for the report editor's picker).
 * GET /api/admin/report-templates
 */
router.get('/admin/report-templates', requireAdmin, (req, res) => {
    try {
        res.json({ success: true, templates: reportTemplates.listTemplates() });
    } catch (error) {
        console.error('Failed to list report templates:', error);
        res.status(500).json({ success: false, error: 'Failed to list templates' });
    }
});

/**
 * Get a single template's .qmd content.
 * GET /api/admin/report-templates/:name
 */
router.get('/admin/report-templates/:name', requireAdmin, (req, res) => {
    try {
        res.json({ success: true, name: reportTemplates.safeName(req.params.name), content: reportTemplates.getTemplate(req.params.name) });
    } catch (error) {
        res.status(404).json({ success: false, error: 'Template not found' });
    }
});

/**
 * Get all reports
 * GET /api/admin/reports
 */
router.get('/admin/reports', requireAdmin, async (req, res) => {
    try {
        const reports = await allAsync(`
            SELECT
                r.*,
                u.username as created_by_username,
                rs.schedule_type,
                rs.schedule_time,
                rs.schedule_day,
                rs.is_active as schedule_active,
                (SELECT COUNT(*) FROM report_runs WHERE report_id = r.id) as total_runs,
                (SELECT COUNT(*) FROM report_runs WHERE report_id = r.id AND status = 'completed') as successful_runs,
                (SELECT started_at FROM report_runs WHERE report_id = r.id ORDER BY started_at DESC LIMIT 1) as last_run,
                rs.next_run
            FROM reports r
            LEFT JOIN admin_users u ON r.created_by = u.id
            LEFT JOIN report_schedules rs ON r.id = rs.report_id
            ORDER BY r.created_at DESC
        `);

        res.json({
            success: true,
            reports
        });
    } catch (error) {
        console.error('Failed to get reports:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to retrieve reports'
        });
    }
});

/**
 * Get specific report
 * GET /api/admin/reports/:id
 */
router.get('/admin/reports/:id', requireAdmin, async (req, res) => {
    try {
        const report = await getAsync(
            'SELECT * FROM reports WHERE id = ?',
            [req.params.id]
        );

        if (!report) {
            return res.status(404).json({
                success: false,
                error: 'Report not found'
            });
        }

        res.json({
            success: true,
            report
        });
    } catch (error) {
        console.error('Failed to get report:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to retrieve report'
        });
    }
});

/**
 * Create new report
 * POST /api/admin/reports
 */
router.post('/admin/reports', requireAdmin, async (req, res) => {
    try {
        const { name, description, qmd_content } = req.body;

        if (!name || !qmd_content) {
            return res.status(400).json({
                success: false,
                error: 'Name and content are required'
            });
        }

        const result = await runAsync(
            `INSERT INTO reports (name, description, qmd_content, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
            [name, description || '', qmd_content, req.session.userId]
        );

        res.json({
            success: true,
            reportId: result.id
        });
    } catch (error) {
        console.error('Failed to create report:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create report'
        });
    }
});

/**
 * Update report
 * PUT /api/admin/reports/:id
 */
router.put('/admin/reports/:id', requireAdmin, async (req, res) => {
    try {
        const { name, description, qmd_content, is_active } = req.body;

        // Build update query dynamically
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
        if (qmd_content !== undefined) {
            updates.push('qmd_content = ?');
            params.push(qmd_content);
        }
        if (is_active !== undefined) {
            updates.push('is_active = ?');
            params.push(is_active ? 1 : 0);
        }

        if (updates.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No updates provided'
            });
        }

        updates.push("updated_at = datetime('now')");
        params.push(req.params.id);

        await runAsync(
            `UPDATE reports SET ${updates.join(', ')} WHERE id = ?`,
            params
        );

        if (is_active !== undefined) {
            await reportScheduler.syncReport(req.params.id);
        }

        res.json({
            success: true,
            message: 'Report updated successfully'
        });
    } catch (error) {
        console.error('Failed to update report:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update report'
        });
    }
});

/**
 * Delete report (soft delete)
 * DELETE /api/admin/reports/:id
 */
router.delete('/admin/reports/:id', requireAdmin, async (req, res) => {
    try {
        await runAsync(
            'UPDATE reports SET is_active = 0 WHERE id = ?',
            [req.params.id]
        );
        await reportScheduler.syncReport(req.params.id);

        res.json({
            success: true,
            message: 'Report deleted successfully'
        });
    } catch (error) {
        console.error('Failed to delete report:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete report'
        });
    }
});

/**
 * Execute report manually
 * POST /api/admin/reports/:id/run
 */
router.post('/admin/reports/:id/run', requireAdmin, async (req, res) => {
    try {
        const reportId = req.params.id;
        const userId = req.session.userId;

        // Start execution asynchronously
        reportExecutor.executeReport(reportId, 'manual', userId)
            .then(runId => {
                console.log(`Report ${reportId} execution completed: ${runId}`);
            })
            .catch(error => {
                console.error(`Report ${reportId} execution failed:`, error);
            });

        // Return immediately
        res.json({
            success: true,
            message: 'Report execution started'
        });
    } catch (error) {
        console.error('Failed to start report execution:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to start report execution'
        });
    }
});

/**
 * Get execution history for a report
 * GET /api/admin/reports/:id/runs
 */
router.get('/admin/reports/:id/runs', requireAdmin, async (req, res) => {
    try {
        const runs = await allAsync(
            `SELECT * FROM report_runs
             WHERE report_id = ?
             ORDER BY started_at DESC
             LIMIT 50`,
            [req.params.id]
        );

        res.json({
            success: true,
            runs
        });
    } catch (error) {
        console.error('Failed to get report runs:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to retrieve report runs'
        });
    }
});

/**
 * Get specific run details
 * GET /api/admin/reports/runs/:runId
 */
router.get('/admin/reports/runs/:runId', requireAdmin, async (req, res) => {
    try {
        const run = await getAsync(
            `SELECT r.*, rep.name as report_name
             FROM report_runs r
             JOIN reports rep ON r.report_id = rep.id
             WHERE r.run_id = ?`,
            [req.params.runId]
        );

        if (!run) {
            return res.status(404).json({
                success: false,
                error: 'Run not found'
            });
        }

        // Get output files
        const outputs = await allAsync(
            'SELECT * FROM report_outputs WHERE run_id = ? ORDER BY file_type',
            [req.params.runId]
        );

        res.json({
            success: true,
            run,
            outputs
        });
    } catch (error) {
        console.error('Failed to get run details:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to retrieve run details'
        });
    }
});

/**
 * Get execution logs
 * GET /api/admin/reports/runs/:runId/logs
 */
router.get('/admin/reports/runs/:runId/logs', requireAdmin, async (req, res) => {
    try {
        const run = await getAsync(
            'SELECT log_output, output_path, status FROM report_runs WHERE run_id = ?',
            [req.params.runId]
        );

        if (!run) {
            return res.status(404).json({
                success: false,
                error: 'Run not found'
            });
        }

        // Try to read log file if database log is empty
        let logs = run.log_output;
        if (!logs && run.output_path) {
            try {
                const logPath = path.join(run.output_path, 'execution.log');
                logs = await fs.readFile(logPath, 'utf8');
            } catch (err) {
                console.error('Failed to read log file:', err);
            }
        }

        res.json({
            success: true,
            logs: logs || 'No logs available',
            status: run.status,
            running: run.status === 'running' || run.status === 'pending'
        });
    } catch (error) {
        console.error('Failed to get logs:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to retrieve logs'
        });
    }
});

/**
 * Download output file
 * GET /api/admin/reports/runs/:runId/download/:format
 */
router.get('/admin/reports/runs/:runId/download/:format', requireAdmin, async (req, res) => {
    try {
        const { runId, format } = req.params;

        // Validate format
        if (!['html', 'pdf', 'docx'].includes(format)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid format'
            });
        }

        // Get output file info
        const output = await getAsync(
            'SELECT * FROM report_outputs WHERE run_id = ? AND file_type = ?',
            [runId, format]
        );

        if (!output) {
            return res.status(404).json({
                success: false,
                error: 'Output file not found'
            });
        }

        // Send file
        const filePath = output.file_path;
        const fileName = `report_${runId}.${format}`;

        res.download(filePath, fileName, (err) => {
            if (err) {
                console.error('Failed to send file:', err);
                res.status(500).json({
                    success: false,
                    error: 'Failed to download file'
                });
            }
        });
    } catch (error) {
        console.error('Failed to download output:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to download output'
        });
    }
});

/**
 * Get report schedule
 * GET /api/admin/reports/:id/schedule
 */
router.get('/admin/reports/:id/schedule', requireAdmin, async (req, res) => {
    try {
        const schedule = await getAsync(
            'SELECT * FROM report_schedules WHERE report_id = ?',
            [req.params.id]
        );

        res.json({
            success: true,
            schedule
        });
    } catch (error) {
        console.error('Failed to get schedule:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to retrieve schedule'
        });
    }
});

/**
 * Create or update report schedule
 * POST /api/admin/reports/:id/schedule
 */
router.post('/admin/reports/:id/schedule', requireAdmin, async (req, res) => {
    try {
        const { schedule_type, schedule_time, schedule_day, is_active } = req.body;

        // Validate inputs
        if (!schedule_type || !schedule_time) {
            return res.status(400).json({
                success: false,
                error: 'Schedule type and time are required'
            });
        }

        if (!['daily', 'weekly', 'monthly'].includes(schedule_type)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid schedule type'
            });
        }

        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule_time)) {
            return res.status(400).json({
                success: false,
                error: 'Time must be HH:MM (24-hour, UTC)'
            });
        }

        const day = schedule_type === 'daily' ? null : Number(schedule_day);
        if (schedule_type === 'weekly' && !(Number.isInteger(day) && day >= 0 && day <= 6)) {
            return res.status(400).json({ success: false, error: 'Day of week must be 0 (Sunday) to 6 (Saturday)' });
        }
        if (schedule_type === 'monthly' && !(Number.isInteger(day) && day >= 1 && day <= 31)) {
            return res.status(400).json({ success: false, error: 'Day of month must be 1 to 31' });
        }

        const report = await getAsync('SELECT id FROM reports WHERE id = ? AND is_active = 1', [req.params.id]);
        if (!report) {
            return res.status(404).json({ success: false, error: 'Report not found' });
        }

        // Check if schedule exists
        const existing = await getAsync(
            'SELECT id FROM report_schedules WHERE report_id = ?',
            [req.params.id]
        );

        if (existing) {
            // Update existing schedule
            await runAsync(
                `UPDATE report_schedules
                 SET schedule_type = ?, schedule_time = ?, schedule_day = ?,
                     is_active = ?
                 WHERE report_id = ?`,
                [schedule_type, schedule_time, day, is_active ? 1 : 0, req.params.id]
            );
        } else {
            // Create new schedule
            await runAsync(
                `INSERT INTO report_schedules (report_id, schedule_type, schedule_time, schedule_day, is_active)
                 VALUES (?, ?, ?, ?, ?)`,
                [req.params.id, schedule_type, schedule_time, day, is_active ? 1 : 0]
            );
        }

        // Start, move or stop the report's job; null when the schedule is off.
        const nextRun = await reportScheduler.syncReport(req.params.id);

        res.json({
            success: true,
            message: 'Schedule updated successfully',
            nextRun
        });
    } catch (error) {
        console.error('Failed to update schedule:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update schedule'
        });
    }
});

/**
 * Delete report schedule
 * DELETE /api/admin/reports/:id/schedule
 */
router.delete('/admin/reports/:id/schedule', requireAdmin, async (req, res) => {
    try {
        await runAsync(
            'DELETE FROM report_schedules WHERE report_id = ?',
            [req.params.id]
        );
        await reportScheduler.syncReport(req.params.id);

        res.json({
            success: true,
            message: 'Schedule deleted successfully'
        });
    } catch (error) {
        console.error('Failed to delete schedule:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete schedule'
        });
    }
});

module.exports = router;