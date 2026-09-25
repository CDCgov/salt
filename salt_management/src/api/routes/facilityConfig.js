const express = require('express');
const { db, getAsync, runAsync } = require('../../models/database');
const { requireFacilityApiKey } = require('../../web/middleware/auth');
const crypto = require('crypto');
const router = express.Router();

/**
 * Get facility configuration
 * GET /api/sync/facility/config
 */
router.get('/facility/config', requireFacilityApiKey, async (req, res) => {
    try {
        // Get facility from auth middleware
        const facilityId = req.facility.id;
        
        // Get facility configuration
        const facility = await getAsync(
            `SELECT
                id as facility_id,
                name as facility_name,
                allow_non_coupon_participants,
                coupons_to_issue,
                seed_recruitment_active,
                seed_contact_rate_days,
                seed_recruitment_window_min_days,
                seed_recruitment_window_max_days,
                subject_payment_type,
                participation_payment_amount,
                recruitment_payment_amount,
                payment_currency,
                payment_currency_symbol,
                enrollment_quota
             FROM facilities
             WHERE id = ?`,
            [facilityId]
        );
        
        if (!facility) {
            return res.status(404).json({
                status: 'error',
                message: 'Facility configuration not found'
            });
        }

        // Live enrolled count for the quota: completed (eligible) surveys the
        // server holds for this facility, excluding admin-deleted ones.
        const enrollment = await getAsync(
            'SELECT COUNT(*) AS n FROM completed_surveys WHERE facility_id = ? AND deleted_at IS NULL',
            [facilityId]
        );
        
        // Return facility configuration
        res.json({
            status: 'success',
            data: {
                facility_id: facility.facility_id,
                facility_name: facility.facility_name,
                allow_non_coupon_participants: Boolean(facility.allow_non_coupon_participants),
                coupons_to_issue: facility.coupons_to_issue,
                seed_recruitment_active: Boolean(facility.seed_recruitment_active),
                seed_contact_rate_days: facility.seed_contact_rate_days || 7,
                seed_recruitment_window_min_days: facility.seed_recruitment_window_min_days || 0,
                seed_recruitment_window_max_days: facility.seed_recruitment_window_max_days || 730,
                subject_payment_type: facility.subject_payment_type || 'None',
                participation_payment_amount: facility.participation_payment_amount || 0,
                recruitment_payment_amount: facility.recruitment_payment_amount || 0,
                payment_currency: facility.payment_currency || 'USD',
                payment_currency_symbol: facility.payment_currency_symbol || '$',
                // null = no quota
                enrollment_quota: facility.enrollment_quota ?? null,
                enrollment_count: enrollment ? enrollment.n : 0,
                sync_time: new Date().toISOString()
            }
        });
        
        console.log(`Facility config sent to facility ${facility.facility_name}: allow_non_coupon=${facility.allow_non_coupon_participants}, coupons=${facility.coupons_to_issue}`);
        
    } catch (error) {
        console.error('Error fetching facility config:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to fetch facility configuration',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * Setup facility using short code
 * POST /api/sync/facility-setup
 * Body: { shortCode: "SALT-XXXX" }
 */
router.post('/facility-setup', async (req, res) => {
    try {
        const { shortCode } = req.body;
        const clientIp = req.ip || req.connection.remoteAddress;

        if (!shortCode || shortCode.length < 6) {
            return res.status(400).json({
                status: 'error',
                message: 'Invalid setup code'
            });
        }

        // Look up the short code
        const codeRecord = await getAsync(
            `SELECT
                sc.*,
                f.name as facility_name,
                f.allow_non_coupon_participants,
                f.coupons_to_issue,
                f.seed_recruitment_active,
                f.seed_contact_rate_days,
                f.seed_recruitment_window_min_days,
                f.seed_recruitment_window_max_days,
                f.subject_payment_type,
                f.participation_payment_amount,
                f.recruitment_payment_amount,
                f.payment_currency,
                f.payment_currency_symbol,
                f.enrollment_quota
             FROM facility_short_codes sc
             JOIN facilities f ON sc.facility_id = f.id
             WHERE sc.short_code = ? AND datetime('now') <= sc.expires_at`,
            [shortCode.toUpperCase()]
        );

        if (!codeRecord) {
            // Check if code exists but expired
            const expiredCode = await getAsync(
                'SELECT * FROM facility_short_codes WHERE short_code = ?',
                [shortCode.toUpperCase()]
            );

            if (expiredCode) {
                return res.status(400).json({
                    status: 'error',
                    message: 'This setup code has expired. Please request a new one.'
                });
            }

            return res.status(400).json({
                status: 'error',
                message: 'Setup code not recognized. Please check and try again.'
            });
        }

        // Check if already used
        if (codeRecord.used_at) {
            return res.status(400).json({
                status: 'error',
                message: 'This setup code has already been used. Please request a new one.'
            });
        }

        // Mark code as used
        await runAsync(
            'UPDATE facility_short_codes SET used_at = datetime("now"), used_by_ip = ? WHERE id = ?',
            [clientIp, codeRecord.id]
        );

        // Live enrolled count for the quota (see GET /facility/config)
        const enrollment = await getAsync(
            'SELECT COUNT(*) AS n FROM completed_surveys WHERE facility_id = ? AND deleted_at IS NULL',
            [codeRecord.facility_id]
        );

        // Return facility configuration with API key
        res.json({
            status: 'success',
            data: {
                api_key: codeRecord.api_key,
                facility_id: codeRecord.facility_id,
                facility_name: codeRecord.facility_name,
                allow_non_coupon_participants: Boolean(codeRecord.allow_non_coupon_participants),
                coupons_to_issue: codeRecord.coupons_to_issue,
                seed_recruitment_active: Boolean(codeRecord.seed_recruitment_active),
                seed_contact_rate_days: codeRecord.seed_contact_rate_days || 7,
                seed_recruitment_window_min_days: codeRecord.seed_recruitment_window_min_days || 0,
                seed_recruitment_window_max_days: codeRecord.seed_recruitment_window_max_days || 730,
                subject_payment_type: codeRecord.subject_payment_type || 'None',
                participation_payment_amount: codeRecord.participation_payment_amount || 0,
                recruitment_payment_amount: codeRecord.recruitment_payment_amount || 0,
                payment_currency: codeRecord.payment_currency || 'USD',
                payment_currency_symbol: codeRecord.payment_currency_symbol || '$',
                enrollment_quota: codeRecord.enrollment_quota ?? null,
                enrollment_count: enrollment ? enrollment.n : 0,
                configured_at: new Date().toISOString()
            }
        });

        console.log(`Facility setup completed for ${codeRecord.facility_name} using code ${shortCode} from IP ${clientIp}`);

    } catch (error) {
        console.error('Error during facility setup:', error);
        res.status(500).json({
            status: 'error',
            message: 'Setup failed. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

module.exports = router;