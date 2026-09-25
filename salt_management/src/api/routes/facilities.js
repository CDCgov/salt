const express = require('express');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const { getAsync, runAsync, allAsync } = require('../../models/database');
const { requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../../services/auditService');
const router = express.Router();

// All routes require admin authentication
router.use(requireAdmin);

// Blank / null / undefined -> null (no quota); otherwise a non-negative integer.
function normalizeQuota(v) {
    if (v === undefined || v === null || v === '') return null;
    return parseInt(v, 10);
}

// List all facilities
router.get('/', async (req, res) => {
    try {
        const facilities = await allAsync(
            `SELECT id, name, location, 
                    allow_non_coupon_participants, 
                    coupons_to_issue,
                    seed_recruitment_active,
                    seed_contact_rate_days,
                    seed_recruitment_window_min_days,
                    seed_recruitment_window_max_days,
                    enrollment_quota,
                    created_at, updated_at 
             FROM facilities ORDER BY name`
        );
        res.json(facilities);
    } catch (error) {
        console.error('Error fetching facilities:', error);
        res.status(500).json({ error: 'Failed to fetch facilities' });
    }
});

// Get single facility
router.get('/:id', async (req, res) => {
    try {
        const facility = await getAsync(
            `SELECT id, name, location, api_key, 
                    allow_non_coupon_participants, 
                    coupons_to_issue,
                    seed_recruitment_active,
                    seed_contact_rate_days,
                    seed_recruitment_window_min_days,
                    seed_recruitment_window_max_days,
                    enrollment_quota,
                    created_at, updated_at 
             FROM facilities WHERE id = ?`,
            [req.params.id]
        );
        
        if (!facility) {
            return res.status(404).json({ error: 'Facility not found' });
        }
        
        // Get upload statistics
        const stats = await getAsync(
            `SELECT 
                COUNT(*) as total_uploads,
                COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_uploads,
                COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_uploads
             FROM uploads WHERE facility_id = ?`,
            [req.params.id]
        );
        
        res.json({ ...facility, statistics: stats });
    } catch (error) {
        console.error('Error fetching facility:', error);
        res.status(500).json({ error: 'Failed to fetch facility' });
    }
});

// Create new facility
router.post('/', [
    body('name').notEmpty().trim(),
    body('location').optional().trim(),
    body('allow_non_coupon_participants').optional().isBoolean(),
    body('coupons_to_issue').optional().isInt({ min: 0, max: 10 }),
    body('seed_recruitment_active').optional().isBoolean(),
    body('seed_contact_rate_days').optional().isInt({ min: 1, max: 365 }),
    body('seed_recruitment_window_min_days').optional().isInt({ min: 0 }),
    body('seed_recruitment_window_max_days').optional().isInt({ min: 1, max: 1095 }),
    body('subject_payment_type').optional().isIn(['None', 'Cash']),
    body('participation_payment_amount').optional().isFloat({ min: 0 }),
    body('recruitment_payment_amount').optional().isFloat({ min: 0 }),
    body('payment_currency').optional().trim(),
    body('payment_currency_symbol').optional().trim(),
    body('enrollment_quota').optional({ nullable: true })
        .custom(v => v === '' || (Number.isInteger(Number(v)) && Number(v) >= 0))
        .withMessage('Enrollment quota must be blank or a non-negative whole number')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    const {
        name,
        location,
        allow_non_coupon_participants = true,
        coupons_to_issue = 3,
        seed_recruitment_active = false,
        seed_contact_rate_days = 7,
        seed_recruitment_window_min_days = 0,
        seed_recruitment_window_max_days = 730,
        subject_payment_type = 'None',
        participation_payment_amount = 0,
        recruitment_payment_amount = 0,
        payment_currency = 'USD',
        payment_currency_symbol = '$',
        enrollment_quota
    } = req.body;
    const apiKey = `salt_${uuidv4()}`;

    try {
        const result = await runAsync(
            `INSERT INTO facilities (name, location, api_key, allow_non_coupon_participants, coupons_to_issue,
                                   seed_recruitment_active, seed_contact_rate_days,
                                   seed_recruitment_window_min_days, seed_recruitment_window_max_days,
                                   subject_payment_type, participation_payment_amount, recruitment_payment_amount,
                                   payment_currency, payment_currency_symbol, enrollment_quota)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, location, apiKey,
             allow_non_coupon_participants ? 1 : 0, coupons_to_issue,
             seed_recruitment_active ? 1 : 0, seed_contact_rate_days,
             seed_recruitment_window_min_days, seed_recruitment_window_max_days,
             subject_payment_type, participation_payment_amount, recruitment_payment_amount,
             payment_currency, payment_currency_symbol, normalizeQuota(enrollment_quota)]
        );

        await logAudit(
            req.session.userId,
            'CREATE_FACILITY',
            'facility',
            result.id,
            null,
            { name, location }
        );

        res.status(201).json({
            id: result.id,
            name,
            location,
            api_key: apiKey,
            message: 'Facility created successfully'
        });
    } catch (error) {
        console.error('Error creating facility:', error);
        res.status(500).json({ error: 'Failed to create facility' });
    }
});

// Update facility
router.put('/:id', [
    body('name').optional().trim(),
    body('location').optional().trim(),
    body('allow_non_coupon_participants').optional().isBoolean(),
    body('coupons_to_issue').optional().isInt({ min: 0, max: 10 }),
    body('seed_recruitment_active').optional().isBoolean(),
    body('seed_contact_rate_days').optional().isInt({ min: 1, max: 365 }),
    body('seed_recruitment_window_min_days').optional().isInt({ min: 0 }),
    body('seed_recruitment_window_max_days').optional().isInt({ min: 1, max: 1095 }),
    body('subject_payment_type').optional().isIn(['None', 'Cash']),
    body('participation_payment_amount').optional().isFloat({ min: 0 }),
    body('recruitment_payment_amount').optional().isFloat({ min: 0 }),
    body('payment_currency').optional().trim(),
    body('payment_currency_symbol').optional().trim(),
    body('enrollment_quota').optional({ nullable: true })
        .custom(v => v === '' || (Number.isInteger(Number(v)) && Number(v) >= 0))
        .withMessage('Enrollment quota must be blank or a non-negative whole number')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    const {
        name, location,
        allow_non_coupon_participants, coupons_to_issue,
        seed_recruitment_active, seed_contact_rate_days,
        seed_recruitment_window_min_days, seed_recruitment_window_max_days,
        subject_payment_type, participation_payment_amount,
        recruitment_payment_amount, payment_currency, payment_currency_symbol,
        enrollment_quota
    } = req.body;
    const facilityId = req.params.id;
    
    console.log('Facility update request:', {
        facilityId,
        name,
        location,
        allow_non_coupon_participants,
        coupons_to_issue,
        seed_recruitment_active,
        seed_contact_rate_days,
        seed_recruitment_window_min_days,
        seed_recruitment_window_max_days,
        body: req.body
    });

    try {
        // Get current facility for audit
        const oldFacility = await getAsync(
            'SELECT name, location, allow_non_coupon_participants, coupons_to_issue FROM facilities WHERE id = ?',
            [facilityId]
        );

        if (!oldFacility) {
            return res.status(404).json({ error: 'Facility not found' });
        }

        // Build update query dynamically based on provided fields
        const updates = [];
        const values = [];
        
        if (name !== undefined) {
            updates.push('name = ?');
            values.push(name);
        }
        if (location !== undefined) {
            updates.push('location = ?');
            values.push(location);
        }
        if (allow_non_coupon_participants !== undefined) {
            updates.push('allow_non_coupon_participants = ?');
            values.push(allow_non_coupon_participants ? 1 : 0);
        }
        if (coupons_to_issue !== undefined) {
            updates.push('coupons_to_issue = ?');
            values.push(coupons_to_issue);
        }
        if (seed_recruitment_active !== undefined) {
            updates.push('seed_recruitment_active = ?');
            values.push(seed_recruitment_active ? 1 : 0);
        }
        if (seed_contact_rate_days !== undefined) {
            updates.push('seed_contact_rate_days = ?');
            values.push(seed_contact_rate_days);
        }
        if (seed_recruitment_window_min_days !== undefined) {
            updates.push('seed_recruitment_window_min_days = ?');
            values.push(seed_recruitment_window_min_days);
        }
        if (seed_recruitment_window_max_days !== undefined) {
            updates.push('seed_recruitment_window_max_days = ?');
            values.push(seed_recruitment_window_max_days);
        }
        if (subject_payment_type !== undefined) {
            updates.push('subject_payment_type = ?');
            values.push(subject_payment_type);
        }
        if (participation_payment_amount !== undefined) {
            updates.push('participation_payment_amount = ?');
            values.push(participation_payment_amount);
        }
        if (recruitment_payment_amount !== undefined) {
            updates.push('recruitment_payment_amount = ?');
            values.push(recruitment_payment_amount);
        }
        if (payment_currency !== undefined) {
            updates.push('payment_currency = ?');
            values.push(payment_currency);
        }
        if (payment_currency_symbol !== undefined) {
            updates.push('payment_currency_symbol = ?');
            values.push(payment_currency_symbol);
        }
        if (enrollment_quota !== undefined) {
            updates.push('enrollment_quota = ?');
            values.push(normalizeQuota(enrollment_quota));
        }

        if (updates.length > 0) {
            updates.push('updated_at = CURRENT_TIMESTAMP');
            values.push(facilityId);
            
            // Update facility
            console.log('Running update query:', `UPDATE facilities SET ${updates.join(', ')} WHERE id = ?`, values);
            const result = await runAsync(
                `UPDATE facilities SET ${updates.join(', ')} WHERE id = ?`,
                values
            );
            console.log('Update result:', result);
        }

        await logAudit(
            req.session.userId,
            'UPDATE_FACILITY',
            'facility',
            facilityId,
            oldFacility,
            { name: name || oldFacility.name, location: location || oldFacility.location }
        );

        res.json({ message: 'Facility updated successfully' });
    } catch (error) {
        console.error('Error updating facility:', error);
        res.status(500).json({ error: 'Failed to update facility' });
    }
});

// Regenerate API key
router.post('/:id/regenerate-key', async (req, res) => {
    const facilityId = req.params.id;
    const newApiKey = `salt_${uuidv4()}`;

    try {
        const facility = await getAsync(
            'SELECT api_key FROM facilities WHERE id = ?',
            [facilityId]
        );

        if (!facility) {
            return res.status(404).json({ error: 'Facility not found' });
        }

        await runAsync(
            'UPDATE facilities SET api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [newApiKey, facilityId]
        );

        await logAudit(
            req.session.userId,
            'REGENERATE_API_KEY',
            'facility',
            facilityId,
            { api_key: facility.api_key },
            { api_key: newApiKey }
        );

        res.json({ 
            api_key: newApiKey,
            message: 'API key regenerated successfully' 
        });
    } catch (error) {
        console.error('Error regenerating API key:', error);
        res.status(500).json({ error: 'Failed to regenerate API key' });
    }
});

// Delete facility
router.delete('/:id', async (req, res) => {
    const facilityId = req.params.id;

    try {
        // Check if facility has uploads
        const uploadCount = await getAsync(
            'SELECT COUNT(*) as count FROM uploads WHERE facility_id = ?',
            [facilityId]
        );

        if (uploadCount.count > 0) {
            return res.status(400).json({ 
                error: 'Cannot delete facility with existing uploads' 
            });
        }

        const facility = await getAsync(
            'SELECT * FROM facilities WHERE id = ?',
            [facilityId]
        );

        if (!facility) {
            return res.status(404).json({ error: 'Facility not found' });
        }

        await runAsync('DELETE FROM facilities WHERE id = ?', [facilityId]);

        await logAudit(
            req.session.userId,
            'DELETE_FACILITY',
            'facility',
            facilityId,
            facility,
            null
        );

        res.json({ message: 'Facility deleted successfully' });
    } catch (error) {
        console.error('Error deleting facility:', error);
        res.status(500).json({ error: 'Failed to delete facility' });
    }
});

// Generate setup short code for facility
router.post('/:id/generate-code', async (req, res) => {
    try {
        const { id } = req.params;
        const { expirationHours = 24 } = req.body;

        // Get facility details
        const facility = await getAsync(
            'SELECT id, name, api_key FROM facilities WHERE id = ?',
            [id]
        );

        if (!facility) {
            return res.status(404).json({ error: 'Facility not found' });
        }

        // Generate unique short code
        const generateShortCode = () => {
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
            let code = '';
            for (let i = 0; i < 6; i++) {
                code += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            return code;
        };

        let shortCode;
        let attempts = 0;
        const maxAttempts = 10;

        // Try to generate unique code
        while (attempts < maxAttempts) {
            shortCode = generateShortCode();
            const existing = await getAsync(
                'SELECT id FROM facility_short_codes WHERE short_code = ?',
                [shortCode]
            );
            if (!existing) break;
            attempts++;
        }

        if (attempts >= maxAttempts) {
            return res.status(500).json({ error: 'Failed to generate unique code' });
        }

        // Calculate expiration time
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + expirationHours);

        // Generate new API key for security
        const newApiKey = `salt_${uuidv4()}`;

        // Update facility with new API key
        await runAsync(
            'UPDATE facilities SET api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [newApiKey, facility.id]
        );

        // Insert short code record with new API key
        await runAsync(
            `INSERT INTO facility_short_codes
             (short_code, facility_id, api_key, expires_at)
             VALUES (?, ?, ?, datetime(?))`,
            [shortCode, facility.id, newApiKey, expiresAt.toISOString()]
        );

        // Log audit
        await logAudit(
            req.session?.userId || 'system',
            'GENERATE_SETUP_CODE',
            'facility',
            facility.id,
            null,
            {
                facility_name: facility.name,
                short_code: shortCode,
                expires_at: expiresAt.toISOString()
            }
        );

        res.json({
            success: true,
            code: shortCode,
            facility_name: facility.name,
            expires_at: expiresAt.toISOString(),
            expiration_hours: expirationHours
        });

    } catch (error) {
        console.error('Error generating setup code:', error);
        res.status(500).json({ error: 'Failed to generate setup code' });
    }
});

// Get active setup codes for a facility
router.get('/:id/setup-codes', async (req, res) => {
    try {
        const { id } = req.params;

        const codes = await allAsync(
            `SELECT short_code, created_at, expires_at, used_at, used_by_ip
             FROM facility_short_codes
             WHERE facility_id = ? AND datetime('now') <= expires_at
             ORDER BY created_at DESC`,
            [id]
        );

        res.json(codes);

    } catch (error) {
        console.error('Error fetching setup codes:', error);
        res.status(500).json({ error: 'Failed to fetch setup codes' });
    }
});

module.exports = router;