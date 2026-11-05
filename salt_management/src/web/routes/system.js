/**
 * System page — server-wide settings, administrators only.
 *
 *   GET  /admin/system                          the page
 *   POST /api/admin/system/settings             { key, value } → change a setting (audited)
 *   POST /api/admin/system/mcp/revoke-sessions  sign every AI assistant out (audited)
 *
 * Settings live in services/systemSettings.js. The MCP switches apply from the
 * next MCP request; turning a feature off doesn't sign anyone out, so the page
 * also offers revoke-all as the immediate kill switch.
 */

const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../../middleware/auth');
const systemSettings = require('../../services/systemSettings');
const sessionStore = require('../../mcp/sessionStore');
const { logAudit } = require('../../services/auditService');

function mcpConnectorUrl(req) {
    const base = (process.env.MCP_PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    return `${base}/mcp`;
}

router.get('/admin/system', requireAdmin, async (req, res) => {
    try {
        res.render('pages/system', {
            title: 'System',
            user: req.user,
            settings: await systemSettings.describe(),
            mcpConnectorUrl: mcpConnectorUrl(req),
            mcpPublicUrlSet: !!process.env.MCP_PUBLIC_URL,
            activeSessions: await sessionStore.countActiveSessions()
        });
    } catch (error) {
        console.error('Error loading system page:', error);
        res.status(500).render('pages/error', { title: 'Error', message: 'Failed to load the System page', user: req.user });
    }
});

router.post('/api/admin/system/settings', requireAdmin, async (req, res) => {
    const { key, value } = req.body || {};
    try {
        const result = await systemSettings.set(key, value, req.user.id);
        res.json({ success: true, ...result });
    } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message });
        console.error('Error saving system setting:', error);
        res.status(500).json({ error: 'Failed to save the setting' });
    }
});

router.post('/api/admin/system/mcp/revoke-sessions', requireAdmin, async (req, res) => {
    try {
        const revoked = await sessionStore.revokeAllSessions();
        await logAudit(req.user.id, 'REVOKE_ALL_MCP_SESSIONS', 'mcp_session', 'all', null, { revoked });
        res.json({ success: true, revoked });
    } catch (error) {
        console.error('Error revoking MCP sessions:', error);
        res.status(500).json({ error: 'Failed to revoke sessions' });
    }
});

module.exports = router;
