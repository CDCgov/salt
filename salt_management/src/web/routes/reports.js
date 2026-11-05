const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../../middleware/auth');
const { getAsync } = require('../../models/database');
const systemSettings = require('../../services/systemSettings');

/**
 * Reports list page
 * GET /reports
 */
router.get('/reports', requireAdmin, async (req, res) => {
    // The MCP connector URL advertised in the "AI Report Builder" dialog. Prefer
    // the configured public URL (the OAuth issuer); fall back to this request's host.
    const base = (process.env.MCP_PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    res.render('pages/reports', {
        title: 'Reports',
        user: req.user,
        // The real state of the System page switch (MCP is always mounted).
        mcpEnabled: await systemSettings.get('mcp_reports_enabled').catch(() => false),
        mcpConnectorUrl: `${base}/mcp`
    });
});

/**
 * New report page
 * GET /reports/new
 */
router.get('/reports/new', requireAdmin, (req, res) => {
    res.render('pages/reportEditor', {
        title: 'Create Report',
        user: req.user,
        id: null,
        report: null
    });
});

/**
 * Edit report page
 * GET /reports/:id/edit
 */
router.get('/reports/:id/edit', requireAdmin, async (req, res) => {
    try {
        const report = await getAsync(
            'SELECT * FROM reports WHERE id = ?',
            [req.params.id]
        );

        if (!report) {
            return res.status(404).render('pages/error', {
                title: 'Error',
                message: 'Report not found',
                user: req.user
            });
        }

        res.render('pages/reportEditor', {
            title: 'Edit Report',
            user: req.user,
            id: report.id,
            report: report
        });
    } catch (error) {
        console.error('Failed to load report for editing:', error);
        res.status(500).render('pages/error', {
            title: 'Error',
            message: 'Failed to load report',
            user: req.user
        });
    }
});

/**
 * Report history page
 * GET /reports/:id/history
 */
router.get('/reports/:id/history', requireAdmin, async (req, res) => {
    try {
        const report = await getAsync(
            'SELECT name FROM reports WHERE id = ?',
            [req.params.id]
        );

        if (!report) {
            return res.status(404).render('pages/error', {
                title: 'Error',
                message: 'Report not found',
                user: req.user
            });
        }

        res.render('pages/reportHistory', {
            title: 'Report History',
            user: req.user,
            id: req.params.id,
            name: report.name
        });
    } catch (error) {
        console.error('Failed to load report history:', error);
        res.status(500).render('pages/error', {
            title: 'Error',
            message: 'Failed to load report history',
            user: req.user
        });
    }
});

module.exports = router;