const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const { getAsync, runAsync } = require('../../models/database');
const { ROLES, getRoleDisplayName } = require('../../constants/roles');
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

        // Determine redirect URL based on role
        let redirectUrl = '/';
        if (user.role === ROLES.LAB_STAFF) {
            redirectUrl = '/lab-entry';
        } else if (user.role === ROLES.ADMINISTRATOR) {
            redirectUrl = '/';  // Dashboard for administrators
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