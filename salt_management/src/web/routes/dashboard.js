/**
 * Dashboard Routes
 *
 * Provides web interface routes for the SALT Management dashboard.
 * Handles user authentication, dashboard statistics, facility management,
 * survey uploads viewing, and JSON data retrieval.
 *
 * Key Responsibilities:
 * - Render main dashboard with statistics
 * - Display facilities list with upload counts
 * - Show upload history with view capabilities
 * - Serve uploaded survey JSON data via API
 * - Handle user login/logout flows
 *
 * Authentication:
 * - All routes require admin authentication via requireAdmin middleware
 * - Session-based authentication with cookies
 * - Login page accessible without authentication
 *
 * Database Tables Used:
 * - facilities: Facility information and configuration
 * - uploads: Survey upload tracking and status
 * - facility_short_codes: Tablet registration codes
 *
 * Related Files:
 * - /middleware/auth.js: Authentication middleware
 * - /views/pages/dashboard.ejs: Dashboard view template
 * - /views/pages/uploads.ejs: Uploads list view
 * - /views/pages/facilities.ejs: Facilities list view
 *
 * API Endpoints:
 * - GET /api/uploads/:surveyId: Fetch uploaded survey JSON data
 *
 * @module web/routes/dashboard
 */

const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const { allAsync, getAsync } = require('../../models/database');
const router = express.Router();

// Login page
router.get('/login', (req, res) => {
    if (req.session.userId) {
        return res.redirect('/');
    }
    res.render('pages/login', { title: 'Login', error: null });
});

// Tablet download page (public, no authentication required)
router.get('/tablet', (req, res) => {
    res.render('pages/tablet', { title: 'Download SALT App' });
});

// Admin redirect
router.get('/admin', requireAdmin, (req, res) => {
    res.redirect('/');
});

// Main dashboard (admin only)
router.get('/', requireAdmin, async (req, res) => {
    try {
        // Get statistics
        const stats = await getAsync(`
            SELECT 
                (SELECT COUNT(*) FROM facilities) as total_facilities,
                (SELECT COUNT(*) FROM uploads) as total_uploads,
                (SELECT COUNT(*) FROM uploads WHERE status = 'completed') as completed_uploads,
                (SELECT COUNT(*) FROM uploads WHERE status = 'failed') as failed_uploads,
                (SELECT COUNT(*) FROM uploads WHERE DATE(upload_time) = DATE('now')) as today_uploads
        `);

        // Get recent uploads
        const recentUploads = await allAsync(`
            SELECT u.*, f.name as facility_name 
            FROM uploads u
            LEFT JOIN facilities f ON u.facility_id = f.id
            ORDER BY u.upload_time DESC
            LIMIT 10
        `);

        res.render('pages/dashboard', {
            title: 'Dashboard',
            user: req.user,
            stats,
            recentUploads
        });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).render('pages/error', {
            title: 'Error',
            message: 'Failed to load dashboard'
        });
    }
});

// Facilities page
router.get('/facilities', requireAdmin, async (req, res) => {
    try {
        const facilities = await allAsync(`
            SELECT f.*,
                   (SELECT COUNT(*) FROM completed_surveys cs
                     WHERE cs.facility_id = f.id AND cs.deleted_at IS NULL) as completed_count,
                   CASE
                       WHEN (
                           SELECT used_at FROM facility_short_codes fsc
                           WHERE fsc.facility_id = f.id
                           ORDER BY fsc.created_at DESC
                           LIMIT 1
                       ) IS NOT NULL THEN 1
                       ELSE 0
                   END as has_active_tablet
            FROM facilities f
            ORDER BY f.name
        `);

        res.render('pages/facilities', {
            title: 'Facilities',
            user: req.user,
            facilities
        });
    } catch (error) {
        console.error('Facilities page error:', error);
        res.status(500).render('pages/error', {
            title: 'Error',
            message: 'Failed to load facilities'
        });
    }
});

// Uploads page
router.get('/uploads', requireAdmin, async (req, res) => {
    try {
        const uploads = await allAsync(`
            SELECT u.*, f.name as facility_name
            FROM uploads u
            LEFT JOIN facilities f ON u.facility_id = f.id
            ORDER BY u.upload_time DESC
            LIMIT 100
        `);

        res.render('pages/uploads', {
            title: 'Uploads',
            user: req.user,
            uploads
        });
    } catch (error) {
        console.error('Uploads page error:', error);
        res.status(500).render('pages/error', {
            title: 'Error',
            message: 'Failed to load uploads'
        });
    }
});

// Get upload JSON data
router.get('/api/uploads/:surveyId', requireAdmin, async (req, res) => {
    try {
        const { surveyId } = req.params;
        const fs = require('fs').promises;

        // Get the file path from the database
        const upload = await getAsync(
            'SELECT file_path FROM uploads WHERE survey_response_id = ?',
            [surveyId]
        );

        if (!upload || !upload.file_path) {
            return res.status(404).json({ error: 'Upload not found' });
        }

        // Read the JSON file
        const jsonData = await fs.readFile(upload.file_path, 'utf-8');
        const data = JSON.parse(jsonData);

        res.json(data);
    } catch (error) {
        console.error('Error fetching upload data:', error);
        res.status(500).json({ error: 'Failed to load upload data' });
    }
});

// Logout
router.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Session destroy error:', err);
        }
        // Clear the session cookie
        res.clearCookie('connect.sid');
        res.redirect('/login');
    });
});

module.exports = router;