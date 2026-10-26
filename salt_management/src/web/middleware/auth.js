const { db, getAsync } = require('../../models/database');

// Staff/admin checks live in src/middleware/auth.js (requireAuth, requireAdmin,
// requireStaffOrAdmin), which verify role and is_active from the database.
// This file only provides the tablet (facility API key) check.

// Middleware to check API key for facility tablet access
async function requireFacilityApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    
    if (!apiKey) {
        return res.status(401).json({ 
            status: 'error', 
            message: 'API key required' 
        });
    }
    
    try {
        // Check if API key exists for a facility
        const facility = await getAsync(
            'SELECT id, name, location FROM facilities WHERE api_key = ?',
            [apiKey]
        );
        
        if (!facility) {
            return res.status(401).json({ 
                status: 'error', 
                message: 'Invalid API key' 
            });
        }
        
        // Log API access in audit log
        db.run(
            `INSERT INTO audit_log (user_id, action, entity_type, entity_id, timestamp)
             VALUES (?, ?, ?, ?, datetime('now'))`,
            [`facility_${facility.id}`, 'api_access', 'endpoint', req.path]
        );
        
        // Attach facility info to request for potential use
        req.facility = facility;
        req.authMethod = 'facility_api_key';
        next();
    } catch (error) {
        console.error('Error validating API key:', error);
        return res.status(500).json({ 
            status: 'error', 
            message: 'Internal server error' 
        });
    }
}

module.exports = {
    requireFacilityApiKey
};