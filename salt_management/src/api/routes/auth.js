const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const { getAsync, runAsync, dbPath } = require('../../models/database');
const { ROLES, getRoleDisplayName } = require('../../constants/roles');
const { logAudit } = require('../../services/auditService');
const { newPasswordProblem, removeInitialPasswordFile } = require('../../services/firstLogin');
const router = express.Router();

// Brute-force guard on the admin login. Keyed by client IP (app.js sets
// `trust proxy`, so req.ip is the real client behind nginx). Only FAILED
// attempts count — a legitimate admin logging in successfully never burns
// the budget — so this throttles password guessing without annoying real
// users sharing an office IP.
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,   // 15 minutes
    max: 10,                    // 10 failed attempts per IP per window
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Please try again later.' }
});

// Admin login
router.post('/login', loginLimiter, [
    body('username').notEmpty().trim(),
    body('password').notEmpty()
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    const { username, password } = req.body;

    try {
        // Get user from database
        const user = await getAsync(
            'SELECT * FROM admin_users WHERE username = ? AND is_active = 1',
            [username]
        );

        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Verify password
        const isValid = await bcrypt.compare(password, user.password_hash);
        if (!isValid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Update last login
        await runAsync(
            'UPDATE admin_users SET last_login = CURRENT_TIMESTAMP WHERE id = ?',
            [user.id]
        );

        // Start a fresh session on login so a session ID planted before login
        // can't be reused afterwards (session fixation).
        await new Promise((resolve, reject) =>
            req.session.regenerate(err => (err ? reject(err) : resolve())));

        // Set session with role information
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.userRole = user.role;
        req.session.fullName = user.full_name;

        // Determine redirect URL based on role; a one-time password must be
        // replaced before anything else (see services/firstLogin.js).
        let redirectUrl = homeFor(user.role);
        if (user.must_change_password) {
            redirectUrl = '/change-password';
        }

        res.json({
            message: 'Login successful',
            user: {
                id: user.id,
                username: user.username,
                role: user.role,
                roleDisplay: getRoleDisplayName(user.role),
                full_name: user.full_name,
                email: user.email
            },
            redirectUrl
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

function homeFor(role) {
    return role === ROLES.LAB_STAFF ? '/lab-entry' : '/';
}

// Same guard as login: only failed attempts count.
const changePasswordLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please try again later.' }
});

// Change your own password. Also the only thing an account with a one-time
// password may do (requireAuth sends it here), so this checks the session
// itself rather than using requireAuth.
router.post('/change-password', changePasswordLimiter, async (req, res) => {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    const { current_password: currentPassword, new_password: newPassword } = req.body || {};
    try {
        const user = await getAsync('SELECT * FROM admin_users WHERE id = ? AND is_active = 1', [req.session.userId]);
        if (!user) return res.status(401).json({ error: 'Authentication required' });

        const ok = typeof currentPassword === 'string' && await bcrypt.compare(currentPassword, user.password_hash);
        if (!ok) return res.status(400).json({ error: 'The current password is incorrect.' });
        const problem = newPasswordProblem(newPassword, currentPassword);
        if (problem) return res.status(400).json({ error: problem });

        const hash = await bcrypt.hash(newPassword, 10);
        if ('must_change_password' in user) {
            await runAsync(
                "UPDATE admin_users SET password_hash = ?, must_change_password = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                [hash, user.id]
            );
        } else {
            await runAsync("UPDATE admin_users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [hash, user.id]);
        }
        removeInitialPasswordFile(dbPath, user.username);
        await logAudit(user.id, 'change_password', 'admin_user', user.id, null,
            { forced: !!user.must_change_password });

        res.json({ message: 'Password changed', redirectUrl: homeFor(user.role) });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Admin logout
router.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ error: 'Logout failed' });
        }
        res.json({ message: 'Logout successful' });
    });
});

// Check authentication status
router.get('/status', (req, res) => {
    if (req.session.userId) {
        res.json({
            authenticated: true,
            user: {
                id: req.session.userId,
                username: req.session.username,
                role: req.session.userRole,
                roleDisplay: getRoleDisplayName(req.session.userRole),
                full_name: req.session.fullName
            }
        });
    } else {
        res.json({ authenticated: false });
    }
});

module.exports = router;