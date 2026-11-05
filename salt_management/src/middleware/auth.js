const { ROLES, hasPermission } = require('../constants/roles');
const { getAsync } = require('../models/database');

// Middleware to check if user is authenticated
const requireAuth = async (req, res, next) => {
    // Check session authentication for web UI
    if (req.session && req.session.userId) {
        try {
            // SELECT * so a database without must_change_password yet still works.
            const row = await getAsync(
                'SELECT * FROM admin_users WHERE id = ? AND is_active = 1',
                [req.session.userId]
            );
            if (row && row.must_change_password) {
                // First login with a one-time password: nothing but
                // /change-password (and logout) until it is changed.
                if (req.originalUrl.startsWith('/api')) {
                    return res.status(403).json({
                        error: 'You must choose a new password first.',
                        code: 'PASSWORD_CHANGE_REQUIRED',
                        redirectUrl: '/change-password'
                    });
                }
                return res.redirect('/change-password');
            }
            if (row) {
                const { id, username, email, full_name, role } = row;
                req.user = { id, username, email, full_name, role };
                return next();
            }
        } catch (error) {
            console.error('Session auth error:', error);
        }
    }

    // Facility API keys are deliberately NOT accepted here. They identify a
    // tablet, not a staff member, and are only valid on the tablet sync
    // endpoints via requireFacilityApiKey (src/web/middleware/auth.js).
    // Accepting them here previously granted administrator access.

    // Not authenticated
    if (req.path.startsWith('/api')) {
        return res.status(401).json({ error: 'Authentication required' });
    } else {
        return res.redirect('/login');
    }
};

// Middleware to require specific permission
const requirePermission = (permission) => {
    return async (req, res, next) => {
        // First ensure user is authenticated
        if (!req.user) {
            await requireAuth(req, res, () => {});
            if (!req.user) {
                return; // requireAuth already handled the response
            }
        }

        // Check permission
        if (hasPermission(req.user.role, permission)) {
            return next();
        }

        // Permission denied
        if (req.path.startsWith('/api')) {
            return res.status(403).json({
                error: 'Access denied',
                required: permission,
                userRole: req.user.role
            });
        } else {
            return res.status(403).render('pages/error', {
                title: 'Access Denied',
                message: 'You do not have permission to access this resource.'
            });
        }
    };
};

// Middleware to require specific role
const requireRole = (role) => {
    return async (req, res, next) => {
        // First ensure user is authenticated
        if (!req.user) {
            await requireAuth(req, res, () => {});
            if (!req.user) {
                return; // requireAuth already handled the response
            }
        }

        // Check role
        if (req.user.role === role) {
            return next();
        }

        // Role mismatch
        if (req.path.startsWith('/api')) {
            return res.status(403).json({
                error: 'Access denied',
                required: role,
                userRole: req.user.role
            });
        } else {
            return res.status(403).render('pages/error', {
                title: 'Access Denied',
                message: 'You do not have permission to access this resource.'
            });
        }
    };
};

// Middleware to require admin role (shorthand)
const requireAdmin = requireRole(ROLES.ADMINISTRATOR);

// Middleware to require lab staff role (shorthand)
const requireLabStaff = requireRole(ROLES.LAB_STAFF);

// Middleware to allow either admin or lab staff
const requireStaffOrAdmin = async (req, res, next) => {
    // First ensure user is authenticated
    if (!req.user) {
        await requireAuth(req, res, () => {});
        if (!req.user) {
            return; // requireAuth already handled the response
        }
    }

    // Check if user is either admin or lab staff
    if (req.user.role === ROLES.ADMINISTRATOR || req.user.role === ROLES.LAB_STAFF) {
        return next();
    }

    // Access denied
    if (req.path.startsWith('/api')) {
        return res.status(403).json({
            error: 'Access denied',
            message: 'Staff or administrator access required'
        });
    } else {
        return res.status(403).render('pages/error', {
            title: 'Access Denied',
            message: 'You do not have permission to access this resource.'
        });
    }
};

module.exports = {
    requireAuth,
    requirePermission,
    requireRole,
    requireAdmin,
    requireLabStaff,
    requireStaffOrAdmin
};