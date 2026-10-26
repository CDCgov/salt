/**
 * Recruitment Payment Upload Routes
 *
 * Handles recruitment payment uploads from Android tablets. This stores
 * payment records for audit purposes when participants return to receive
 * recruitment compensation.
 *
 * Key Responsibilities:
 * - Receive and validate recruitment payment data from tablets
 * - Store payment JSON files to disk for archival
 * - Prevent duplicate payment uploads
 * - Handle offline retry scenarios gracefully
 *
 * Data Flow:
 * 1. Tablet sends POST request with payment JSON
 * 2. Validate facility authentication via API key
 * 3. Check for duplicate paymentId (prevent re-processing)
 * 4. Save complete JSON to /data/uploads/recruitment_payments/ directory
 * 5. Return success response to tablet
 *
 * Authentication:
 * - Requires facility API key via Bearer token
 * - Key format: "salt_<uuid>"
 * - Validated by requireFacilityApiKey middleware
 *
 * Related Files:
 * - /middleware/auth.js: API key authentication
 * - Android: RecruitmentPaymentUploadManager.kt, RecruitmentPaymentScreen.kt
 *
 * API Endpoints:
 * - POST /api/sync/recruitment-payment/upload: Upload recruitment payment record
 *
 * @module api/routes/recruitmentPaymentUpload
 */

const express = require('express');
const path = require('path');
const { isSafeId, safeJoin } = require('../../utils/safeIds');
const fs = require('fs').promises;
const { runAsync, getAsync } = require('../../models/database');
const { requireFacilityApiKey } = require('../../web/middleware/auth');
const router = express.Router();

// Track uploaded payment IDs in memory to quickly detect duplicates
// (Also checked in file system, but this is faster for recent uploads)
const recentPaymentIds = new Set();

/**
 * Upload a recruitment payment record from facility tablet
 * POST /api/sync/recruitment-payment/upload
 */
router.post('/recruitment-payment/upload', requireFacilityApiKey, async (req, res) => {
    try {
        // Get facility info from auth middleware
        const facility = req.facility;

        // Extract payment data from request body
        const paymentData = req.body;

        // Debug logging
        console.log('Received recruitment payment upload:', {
            paymentId: paymentData.paymentId,
            surveyId: paymentData.surveyId,
            subjectId: paymentData.subjectId,
            couponCount: paymentData.couponCodes?.length || 0,
            amount: paymentData.totalAmount,
            facility: facility.name
        });

        // Validate required fields
        if (!paymentData.paymentId) {
            return res.status(400).json({
                status: 'error',
                message: 'Invalid payment data: missing paymentId'
            });
        }
        // The payment ID becomes part of a file name; tablets send UUIDs.
        if (!isSafeId(paymentData.paymentId)) {
            return res.status(400).json({
                status: 'error',
                message: 'Invalid payment data: malformed paymentId'
            });
        }

        if (!paymentData.surveyId) {
            return res.status(400).json({
                status: 'error',
                message: 'Invalid payment data: missing surveyId'
            });
        }

        if (!paymentData.couponCodes || !Array.isArray(paymentData.couponCodes) || paymentData.couponCodes.length === 0) {
            return res.status(400).json({
                status: 'error',
                message: 'Invalid payment data: missing or empty couponCodes array'
            });
        }

        // Check for duplicate in memory cache
        if (recentPaymentIds.has(paymentData.paymentId)) {
            console.log(`Recruitment payment ${paymentData.paymentId} already uploaded (cache hit)`);
            return res.json({
                status: 'success',
                message: 'Payment already uploaded',
                duplicate: true
            });
        }

        // Check for duplicate on disk
        const uploadsDir = path.join(__dirname, '..', '..', '..', 'data', 'uploads', 'recruitment_payments');
        await fs.mkdir(uploadsDir, { recursive: true });

        // Look for existing file with this paymentId
        try {
            const files = await fs.readdir(uploadsDir);
            const existingFile = files.find(f => f.includes(paymentData.paymentId));
            if (existingFile) {
                console.log(`Recruitment payment ${paymentData.paymentId} already uploaded (file exists)`);
                recentPaymentIds.add(paymentData.paymentId);
                return res.json({
                    status: 'success',
                    message: 'Payment already uploaded',
                    duplicate: true
                });
            }
        } catch (err) {
            // Directory might not exist yet, that's fine
        }

        // Generate filename for JSON storage
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `payment_${facility.id}_${timestamp}_${paymentData.paymentId}.json`;

        // Prepare upload data with metadata
        const uploadData = {
            payment_id: paymentData.paymentId,
            survey_id: paymentData.surveyId,
            subject_id: paymentData.subjectId,
            facility_id: facility.id,
            facility_name: facility.name,
            upload_time: new Date().toISOString(),
            payment_data: {
                phone: paymentData.phone || null,
                totalAmount: paymentData.totalAmount,
                currency: paymentData.currency || 'USD',
                paymentDate: paymentData.paymentDate,
                confirmationMethod: paymentData.confirmationMethod,
                signatureHex: paymentData.signatureHex || null,
                couponCodes: paymentData.couponCodes,
                deviceInfo: paymentData.deviceInfo || {}
            }
        };

        // Save to file system
        const filepath = safeJoin(uploadsDir, filename);
        await fs.writeFile(filepath, JSON.stringify(uploadData, null, 2));

        // Add to memory cache
        recentPaymentIds.add(paymentData.paymentId);

        // Keep cache from growing indefinitely (remove old entries after 1000)
        if (recentPaymentIds.size > 1000) {
            const iterator = recentPaymentIds.values();
            recentPaymentIds.delete(iterator.next().value);
        }

        // Log to audit trail
        try {
            await runAsync(
                `INSERT INTO audit_log (user_id, action, entity_type, entity_id, new_value, timestamp)
                 VALUES (?, ?, ?, ?, ?, datetime('now'))`,
                [
                    `facility_${facility.id}`,
                    'recruitment_payment_upload',
                    'recruitment_payment',
                    paymentData.paymentId,
                    JSON.stringify({
                        facility: facility.name,
                        surveyId: paymentData.surveyId,
                        subjectId: paymentData.subjectId,
                        amount: paymentData.totalAmount,
                        couponCount: paymentData.couponCodes.length
                    })
                ]
            );
        } catch (auditError) {
            // Don't fail the upload if audit logging fails
            console.error('Failed to log recruitment payment to audit trail:', auditError);
        }

        console.log(`Recruitment payment ${paymentData.paymentId} uploaded successfully from facility ${facility.name}`);
        console.log(`  Survey: ${paymentData.surveyId}, Subject: ${paymentData.subjectId}`);
        console.log(`  Amount: ${paymentData.totalAmount} ${paymentData.currency || 'USD'}`);
        console.log(`  Coupons: ${paymentData.couponCodes.join(', ')}`);

        // Return success response
        res.json({
            status: 'success',
            message: 'Recruitment payment uploaded successfully',
            data: {
                payment_id: paymentData.paymentId,
                uploaded_at: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('Error uploading recruitment payment:', error);

        // Log error in audit log
        if (req.facility) {
            try {
                await runAsync(
                    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, old_value, timestamp)
                     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
                    [
                        `facility_${req.facility.id}`,
                        'recruitment_payment_upload_error',
                        'error',
                        req.body?.paymentId || 'unknown',
                        error.message
                    ]
                );
            } catch (auditError) {
                console.error('Failed to log error to audit trail:', auditError);
            }
        }

        res.status(500).json({
            status: 'error',
            message: 'Failed to upload recruitment payment',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

module.exports = router;
