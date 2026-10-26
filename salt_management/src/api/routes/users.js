const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { getAsync, allAsync, runAsync } = require('../../models/database');
const { requireAdmin, requireAuth } = require('../../middleware/auth');
const { ROLES, isValidRole, getRoleDisplayName } = require('../../constants/roles');
const { revokeAllForUser } = require('../../mcp/sessionStore');
const { redactSecrets } = require('../../services/redact');

const MIN_PASSWORD_LENGTH = 12;

// Get all users (admin only)
router.get('/', requireAdmin, async (req, res) => {
    try {
        const { role, active } = req.query;

        let query = `
            SELECT id, username, email, full_name, role, is_active,
                   created_at, last_login, updated_at
            FROM admin_users
            WHERE 1=1
        `;
        const params = [];

        // Filter by role if specified
        if (role && isValidRole(role)) {
            query += ' AND role = ?';
            params.push(role);
        }

        // Filter by active status if specified
        if (active !== undefined) {
            query += ' AND is_active = ?';
            params.push(active === 'true' ? 1 : 0);
        }

        query += ' ORDER BY created_at DESC';

        const users = await allAsync(query, params);

        // Remove password hashes and enhance response
        const sanitizedUsers = users.map(user => ({
            ...user,
            roleDisplay: getRoleDisplayName(user.role),
            password_hash: undefined
        }));

        res.json({
            success: true,
            users: sanitizedUsers,
            total: sanitizedUsers.length
        });
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// Get single user (admin or self)
router.get('/:id', requireAuth, async (req, res) => {
    try {
        const userId = parseInt(req.params.id);

        // Check if user is viewing their own profile or is admin
        if (req.user.role !== ROLES.ADMINISTRATOR && req.user.id !== userId) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const user = await getAsync(
            `SELECT id, username, email, full_name, role, is_active,
                    created_at, last_login, updated_at
             FROM admin_users WHERE id = ?`,
            [userId]
        );

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({
            success: true,
            user: {
                ...user,
                roleDisplay: getRoleDisplayName(user.role)
            }
        });
    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({ error: 'Failed to fetch user' });
    }
});

// Create new user (admin only)
router.post('/',
    requireAdmin,
    [
        body('username')
            .trim()
            .isLength({ min: 3, max: 50 })
            .matches(/^[a-zA-Z0-9_]+$/)
            .withMessage('Username must be 3-50 characters and contain only letters, numbers, and underscores'),
        body('password')
            .isLength({ min: MIN_PASSWORD_LENGTH })
            .withMessage(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`),
        body('email')
            .optional()
            .isEmail()
            .normalizeEmail()
            .withMessage('Invalid email address'),
        body('full_name')
            .optional()
            .trim()
            .isLength({ max: 100 })
            .withMessage('Full name must not exceed 100 characters'),
        body('role')
            .custom(isValidRole)
            .withMessage('Invalid role')
    ],
    async (req, res) => {
        // Check validation errors
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        try {
            const { username, password, email, full_name, role } = req.body;

            // Check if username already exists
            const existingUser = await getAsync(
                'SELECT id FROM admin_users WHERE username = ?',
                [username]
            );

            if (existingUser) {
                return res.status(409).json({ error: 'Username already exists' });
            }

            // Check if email already exists (if provided)
            if (email) {
                const existingEmail = await getAsync(
                    'SELECT id FROM admin_users WHERE email = ?',
                    [email]
                );

                if (existingEmail) {
                    return res.status(409).json({ error: 'Email already exists' });
                }
            }

            // Hash password
            const hashedPassword = await bcrypt.hash(password, 10);

            // Create user
            const result = await runAsync(
                `INSERT INTO admin_users (username, password_hash, email, full_name, role, is_active)
                 VALUES (?, ?, ?, ?, ?, 1)`,
                [username, hashedPassword, email || null, full_name || null, role]
            );

            // Log the action
            await runAsync(
                `INSERT INTO audit_log (user_id, action, entity_type, entity_id, new_value)
                 VALUES (?, ?, ?, ?, ?)`,
                [req.user.id, 'CREATE_USER', 'user', result.id, JSON.stringify({
                    username,
                    role,
                    email,
                    full_name
                })]
            );

            res.status(201).json({
                success: true,
                message: 'User created successfully',
                userId: result.id
            });
        } catch (error) {
            console.error('Error creating user:', error);
            res.status(500).json({ error: 'Failed to create user' });
        }
    }
);

// Update user (admin only, or self for password/email)
router.put('/:id',
    requireAuth,
    [
        body('email')
            .optional()
            .isEmail()
            .normalizeEmail()
            .withMessage('Invalid email address'),
        body('full_name')
            .optional()
            .trim()
            .isLength({ max: 100 })
            .withMessage('Full name must not exceed 100 characters'),
        body('role')
            .optional()
            .custom(isValidRole)
            .withMessage('Invalid role'),
        body('is_active')
            .optional()
            .isBoolean()
            .withMessage('Active status must be a boolean'),
        body('password')
            .optional()
            .isLength({ min: MIN_PASSWORD_LENGTH })
            .withMessage(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    ],
    async (req, res) => {
        // Check validation errors
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        try {
            const userId = parseInt(req.params.id);
            const { email, full_name, role, is_active, password } = req.body;

            // Check permissions
            const isAdmin = req.user.role === ROLES.ADMINISTRATOR;
            const isSelf = req.user.id === userId;

            if (!isAdmin && !isSelf) {
                return res.status(403).json({ error: 'Access denied' });
            }

            // Non-admins can only update their own email, full_name, and password
            if (!isAdmin && (role !== undefined || is_active !== undefined)) {
                return res.status(403).json({
                    error: 'You can only update your email, name, and password'
                });
            }

            // Check if user exists
            const existingUser = await getAsync(
                'SELECT id, role FROM admin_users WHERE id = ?',
                [userId]
            );

            if (!existingUser) {
                return res.status(404).json({ error: 'User not found' });
            }

            // Prevent removing last administrator
            if (isAdmin && role === ROLES.LAB_STAFF) {
                const adminCount = await getAsync(
                    'SELECT COUNT(*) as count FROM admin_users WHERE role = ? AND id != ?',
                    [ROLES.ADMINISTRATOR, userId]
                );

                if (adminCount.count === 0) {
                    return res.status(400).json({
                        error: 'Cannot change role: this is the last administrator'
                    });
                }
            }

            // Build update query
            const updates = [];
            const params = [];

            if (email !== undefined) {
                // Check if email is already taken
                const emailTaken = await getAsync(
                    'SELECT id FROM admin_users WHERE email = ? AND id != ?',
                    [email, userId]
                );
                if (emailTaken) {
                    return res.status(409).json({ error: 'Email already exists' });
                }
                updates.push('email = ?');
                params.push(email);
            }

            if (full_name !== undefined) {
                updates.push('full_name = ?');
                params.push(full_name);
            }

            if (isAdmin && role !== undefined) {
                updates.push('role = ?');
                params.push(role);
            }

            if (isAdmin && is_active !== undefined) {
                updates.push('is_active = ?');
                params.push(is_active ? 1 : 0);
            }

            if (password !== undefined) {
                // Changing your own password requires your current password.
                if (isSelf) {
                    const current = await getAsync('SELECT password_hash FROM admin_users WHERE id = ?', [userId]);
                    const ok = current && typeof req.body.current_password === 'string' &&
                        await bcrypt.compare(req.body.current_password, current.password_hash);
                    if (!ok) {
                        return res.status(400).json({ error: 'Current password is incorrect' });
                    }
                }
                const hashedPassword = await bcrypt.hash(password, 10);
                updates.push('password_hash = ?');
                params.push(hashedPassword);
            }

            if (updates.length === 0) {
                return res.status(400).json({ error: 'No valid updates provided' });
            }

            // Add userId to params
            params.push(userId);

            // Execute update
            await runAsync(
                `UPDATE admin_users SET ${updates.join(', ')} WHERE id = ?`,
                params
            );

            // Deactivated or no longer an administrator: end any report-builder
            // (MCP) connections immediately.
            if (isAdmin && ((is_active !== undefined && !is_active) ||
                            (role !== undefined && role !== ROLES.ADMINISTRATOR))) {
                await revokeAllForUser(userId);
            }

            // Log the action
            await runAsync(
                `INSERT INTO audit_log (user_id, action, entity_type, entity_id, new_value)
                 VALUES (?, ?, ?, ?, ?)`,
                [req.user.id, 'UPDATE_USER', 'user', userId, JSON.stringify(redactSecrets(req.body))]
            );

            res.json({
                success: true,
                message: 'User updated successfully'
            });
        } catch (error) {
            console.error('Error updating user:', error);
            res.status(500).json({ error: 'Failed to update user' });
        }
    }
);

// Delete user (admin only)
router.delete('/:id', requireAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.id);

        // Prevent self-deletion
        if (req.user.id === userId) {
            return res.status(400).json({ error: 'Cannot delete your own account' });
        }

        // Check if user exists
        const existingUser = await getAsync(
            'SELECT id, username, role FROM admin_users WHERE id = ?',
            [userId]
        );

        if (!existingUser) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Prevent deleting last administrator
        if (existingUser.role === ROLES.ADMINISTRATOR) {
            const adminCount = await getAsync(
                'SELECT COUNT(*) as count FROM admin_users WHERE role = ? AND id != ?',
                [ROLES.ADMINISTRATOR, userId]
            );

            if (adminCount.count === 0) {
                return res.status(400).json({
                    error: 'Cannot delete the last administrator'
                });
            }
        }

        // Soft delete (set is_active to 0) instead of hard delete
        await runAsync(
            'UPDATE admin_users SET is_active = 0 WHERE id = ?',
            [userId]
        );
        await revokeAllForUser(userId); // end any report-builder (MCP) connections

        // Log the action
        await runAsync(
            `INSERT INTO audit_log (user_id, action, entity_type, entity_id, old_value)
             VALUES (?, ?, ?, ?, ?)`,
            [req.user.id, 'DELETE_USER', 'user', userId, JSON.stringify({
                username: existingUser.username,
                role: existingUser.role
            })]
        );

        res.json({
            success: true,
            message: 'User deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting user:', error);
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

module.exports = router;