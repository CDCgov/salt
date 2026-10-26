/**
 * Survey Upload Routes
 *
 * Handles survey data uploads from Android tablets. This is a critical component
 * that processes completed survey submissions, stores data in multiple formats,
 * and maintains recruitment chain tracking.
 *
 * Key Responsibilities:
 * - Receive and validate survey data from tablets via API
 * - Store survey JSON files to disk for archival
 * - Insert structured data into relational database tables
 * - Track coupon usage and recruitment chains
 * - Record rapid test results and payment information
 * - Prevent duplicate survey uploads
 * - Provide upload statistics to facilities
 *
 * Data Flow:
 * 1. Tablet sends POST request with survey JSON
 * 2. Validate facility authentication via API key
 * 3. Check for duplicate uploads (prevent re-processing)
 * 4. Save complete JSON to /data/uploads/surveys/ directory
 * 5. Begin database transaction
 * 6. Insert into completed_surveys table (main survey record)
 * 7. Insert answers into survey_responses table (one row per answer)
 * 8. Insert rapid test results if present
 * 9. Track coupon usage and issuance
 * 10. Record payment and sample collection info
 * 11. Commit transaction or rollback on error
 * 12. Log audit trail
 * 13. Return success response to tablet
 *
 * Authentication:
 * - Requires facility API key via Bearer token
 * - Key format: "salt_<uuid>"
 * - Validated by requireFacilityApiKey middleware
 *
 * Database Tables Modified:
 * - completed_surveys: Main survey record with metadata
 * - survey_responses: Individual answer records
 * - rapid_test_results: HIV rapid test results
 * - coupon_usage: Tracks coupon issuance and redemption
 * - survey_payments: Payment confirmation and sample collection
 * - uploads: Upload tracking (legacy compatibility)
 * - audit_log: Audit trail for uploads
 *
 * Error Handling:
 * - Duplicate prevention: Returns success if already uploaded
 * - Transaction rollback: Database changes reverted on error
 * - File-based fallback: JSON saved even if database insert fails
 * - Audit logging: All errors logged for investigation
 *
 * Related Files:
 * - /middleware/auth.js: API key authentication
 * - /models/database.js: Database connection utilities
 * - Android: SurveyUploadManager.kt, SurveySerializer.kt
 *
 * API Endpoints:
 * - POST /api/sync/survey/upload: Upload completed survey
 * - GET /api/sync/survey/upload/stats: Get facility upload statistics
 *
 * @module api/routes/surveyUpload
 */

const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const { db, runAsync, getAsync } = require('../../models/database');
const { requireFacilityApiKey } = require('../../web/middleware/auth');
const { isSafeId, safeJoin } = require('../../utils/safeIds');
const router = express.Router();

/**
 * Upload a completed survey from facility tablet
 * POST /api/sync/survey/upload
 */
router.post('/survey/upload', requireFacilityApiKey, async (req, res) => {
    try {
        // Get facility info from auth middleware
        const facility = req.facility;
        
        // Extract survey data from request body
        // The Android app sends data in a flat structure
        const surveyData = req.body;
        
        // Debug logging
        console.log('Received upload data keys:', Object.keys(surveyData));
        console.log('Survey ID field:', surveyData.surveyId);
        
        // Validate required fields
        if (!surveyData.surveyId) {
            console.error('Missing survey ID. Received data:', JSON.stringify(surveyData).substring(0, 200));
            return res.status(400).json({
                status: 'error',
                message: 'Invalid survey data: missing survey ID'
            });
        }
        // The survey ID becomes part of a file name; tablets send UUIDs.
        if (!isSafeId(surveyData.surveyId)) {
            return res.status(400).json({
                status: 'error',
                message: 'Invalid survey data: malformed survey ID'
            });
        }
        
        if (!surveyData.answers || !Array.isArray(surveyData.answers)) {
            return res.status(400).json({
                status: 'error',
                message: 'Invalid survey data: missing or invalid answers array'
            });
        }
        
        // Check if this survey has already been uploaded (prevent duplicates)
        const existingUpload = await getAsync(
            'SELECT id FROM uploads WHERE survey_response_id = ?',
            [surveyData.surveyId]
        );
        
        if (existingUpload) {
            // Survey already uploaded, return success to allow client to clear it
            console.log(`Survey ${surveyData.surveyId} already uploaded, returning success`);
            return res.json({
                status: 'success',
                message: 'Survey already uploaded',
                data: {
                    survey_id: surveyData.surveyId,
                    upload_id: existingUpload.id,
                    duplicate: true
                }
            });
        }
        
        // Generate filename for JSON storage
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `survey_${facility.id}_${timestamp}_${surveyData.surveyId}.json`;
        
        // Prepare upload data
        const uploadData = {
            survey_response_id: surveyData.surveyId,
            facility_id: facility.id,
            facility_name: facility.name,
            upload_time: new Date().toISOString(),
            survey_data: surveyData
        };
        
        // Save to file system
        const uploadsDir = path.join(__dirname, '..', '..', '..', 'data', 'uploads', 'surveys');
        await fs.mkdir(uploadsDir, { recursive: true });
        const filepath = safeJoin(uploadsDir, filename);
        await fs.writeFile(filepath, JSON.stringify(uploadData, null, 2));

        // Begin transaction for database insertion
        await runAsync('BEGIN TRANSACTION');

        try {
            // Use serverSurveyId from uploaded data if available
            let surveyId = null;

            if (surveyData.serverSurveyId) {
                surveyId = surveyData.serverSurveyId;
                console.log(`Using serverSurveyId ${surveyId} from uploaded data`);
            } else {
                // Fallback: Try to determine survey ID from question IDs in the uploaded data
                console.warn('WARNING: serverSurveyId not found in uploaded data, attempting fallback matching');

                if (surveyData.questions && surveyData.questions.length > 0) {
                    const firstQuestionId = surveyData.questions[0].id;
                    const questionMatch = await getAsync(
                        'SELECT survey_id FROM questions WHERE id = ?',
                        [firstQuestionId]
                    );
                    if (questionMatch) {
                        surveyId = questionMatch.survey_id;
                        console.log(`Matched survey ID ${surveyId} from question ID ${firstQuestionId}`);
                    }
                }

                // Fallback: try to match by question short_name if question ID didn't work
                if (!surveyId && surveyData.answers && surveyData.answers.length > 0) {
                    const firstAnswer = surveyData.answers[0];
                    const questionMatch = await getAsync(
                        'SELECT survey_id FROM questions WHERE short_name = ? LIMIT 1',
                        [firstAnswer.questionShortName]
                    );
                    if (questionMatch) {
                        surveyId = questionMatch.survey_id;
                        console.log(`Matched survey ID ${surveyId} from question short_name ${firstAnswer.questionShortName}`);
                    }
                }

                // Final fallback to survey 1 (with warning)
                if (!surveyId) {
                    surveyId = 1;
                    console.error('ERROR: Could not determine survey ID from uploaded data, defaulting to survey 1. This may cause data to be associated with the wrong survey!');
                }
            }

            // Insert into completed_surveys table
            const completedSurveyResult = await runAsync(
                `INSERT INTO completed_surveys (
                    survey_response_id,
                    participant_id,
                    survey_id,
                    facility_id,
                    started_at,
                    completed_at,
                    language,
                    device_id,
                    device_model,
                    android_version,
                    app_version,
                    referral_coupon_code,
                    issued_coupons,
                    json_file_path,
                    consent_signature_path
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    surveyData.surveyId,
                    surveyData.subjectId || surveyData.participantId || 'UNKNOWN',
                    surveyId,
                    facility.id,
                    surveyData.startDatetime || surveyData.startedAt || new Date().toISOString(),
                    surveyData.completedAt || new Date().toISOString(),
                    surveyData.language || 'English',
                    surveyData.deviceInfo?.deviceId || null,
                    surveyData.deviceInfo?.deviceModel || null,
                    surveyData.deviceInfo?.androidVersion || null,
                    surveyData.deviceInfo?.appVersion || null,
                    surveyData.referralCouponCode || null,
                    surveyData.issuedCoupons ? JSON.stringify(surveyData.issuedCoupons) : null,
                    filepath,
                    surveyData.consentSignaturePath || null
                ]
            );

            const completedSurveyId = completedSurveyResult.id;

            // Insert each answer into survey_responses table
            if (surveyData.answers && Array.isArray(surveyData.answers)) {
                for (const answer of surveyData.answers) {
                    // Try to find question ID from database
                    const questionInfo = await getAsync(
                        'SELECT id FROM questions WHERE short_name = ? AND survey_id = ?',
                        [answer.questionShortName, surveyId]
                    );

                    await runAsync(
                        `INSERT INTO survey_responses (
                            completed_survey_id,
                            question_id,
                            question_index,
                            question_short_name,
                            response_value,
                            response_option_index,
                            response_option_text,
                            response_multi_indices,
                            answer_type
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                            completedSurveyId,
                            questionInfo?.id || null,
                            answer.questionId || 0,
                            answer.questionShortName || null,
                            // For text/numeric answers, store the value
                            (answer.answerType === 'text' || answer.answerType === 'numeric') ? answer.answerValue : null,
                            // For single choice, store the index
                            answer.answerType === 'multiple_choice' ? answer.answerValue : null,
                            // Store option text for reporting
                            answer.optionText || null,
                            // For multi-select, store comma-separated indices
                            answer.answerType === 'multi_select' ? answer.answerValue : null,
                            answer.answerType || 'unknown'
                        ]
                    );
                }
            }

            // Insert rapid test results if present
            if (surveyData.testResults && Array.isArray(surveyData.testResults)) {
                for (const test of surveyData.testResults) {
                    await runAsync(
                        `INSERT INTO rapid_test_results (
                            completed_survey_id,
                            test_id,
                            test_name,
                            result,
                            recorded_at
                        ) VALUES (?, ?, ?, ?, ?)`,
                        [
                            completedSurveyId,
                            test.testId,
                            test.testName,
                            test.result,
                            test.recordedAt || new Date().toISOString()
                        ]
                    );
                }
            }

            // Track coupon usage. Upsert preserves issued_by_survey_id /
            // issued_at written earlier by the parent survey's upload — the
            // previous INSERT OR REPLACE here was wiping that side of the row.
            if (surveyData.referralCouponCode) {
                await runAsync(
                    `INSERT INTO coupon_usage (
                        coupon_code,
                        used_by_survey_id,
                        used_at,
                        facility_id
                    ) VALUES (?, ?, datetime('now'), ?)
                    ON CONFLICT(coupon_code) DO UPDATE SET
                        used_by_survey_id = excluded.used_by_survey_id,
                        used_at = excluded.used_at,
                        facility_id = excluded.facility_id`,
                    [
                        surveyData.referralCouponCode,
                        surveyData.surveyId,
                        facility.id
                    ]
                );
            }

            // Track issued coupons. Same upsert pattern so we don't drop
            // used_by_survey_id / used_at if a row already exists (e.g. if
            // the child survey somehow uploaded before the parent).
            if (surveyData.issuedCoupons && Array.isArray(surveyData.issuedCoupons)) {
                for (const coupon of surveyData.issuedCoupons) {
                    await runAsync(
                        `INSERT INTO coupon_usage (
                            coupon_code,
                            issued_by_survey_id,
                            issued_at,
                            facility_id
                        ) VALUES (?, ?, datetime('now'), ?)
                        ON CONFLICT(coupon_code) DO UPDATE SET
                            issued_by_survey_id = excluded.issued_by_survey_id,
                            issued_at = excluded.issued_at,
                            facility_id = excluded.facility_id`,
                        [
                            coupon,
                            surveyData.surveyId,
                            facility.id
                        ]
                    );
                }
            }

            // Insert payment and sample collection information
            if (surveyData.paymentConfirmed !== undefined || surveyData.sampleCollected !== undefined) {
                await runAsync(
                    `INSERT INTO survey_payments (
                        completed_survey_id,
                        payment_confirmed,
                        payment_amount,
                        payment_type,
                        payment_date,
                        sample_collected
                    ) VALUES (?, ?, ?, ?, ?, ?)`,
                    [
                        completedSurveyId,
                        surveyData.paymentConfirmed || false,
                        surveyData.paymentAmount || null,
                        surveyData.paymentType || null,
                        surveyData.paymentDate || null,
                        surveyData.sampleCollected || false
                    ]
                );
            }

            // Save upload record to uploads table (for backward compatibility)
            const result = await runAsync(
                `INSERT INTO uploads (
                    survey_response_id,
                    facility_id,
                    upload_time,
                    file_path,
                    status,
                    participant_id
                ) VALUES (?, ?, datetime('now'), ?, ?, ?)`,
                [
                    surveyData.surveyId,
                    facility.id,
                    filepath,
                    'COMPLETED',
                    surveyData.subjectId || null
                ]
            );

            // Commit transaction
            await runAsync('COMMIT');

            console.log(`Survey ${surveyData.surveyId} successfully inserted into database`);

            // Return the result for the response
            var uploadId = result.id;
        } catch (error) {
            // Rollback transaction on error
            await runAsync('ROLLBACK');
            console.error('Error inserting survey data into database:', error);
            // Continue with file-based storage even if database insertion fails
            // This ensures surveys aren't lost
            var uploadId = null;
        }

        // Log the upload in audit log
        await runAsync(
            `INSERT INTO audit_log (user_id, action, entity_type, entity_id, new_value, timestamp)
             VALUES (?, ?, ?, ?, ?, datetime('now'))`,
            [
                `facility_${facility.id}`,
                'survey_upload',
                'survey',
                surveyData.surveyId,
                JSON.stringify({ 
                    facility: facility.name,
                    answers_count: surveyData.answers.length,
                    device: surveyData.deviceInfo?.deviceModel 
                })
            ]
        );
        
        // Log coupon information if present
        if (surveyData.referralCouponCode) {
            console.log(`Survey ${surveyData.surveyId} used referral coupon: ${surveyData.referralCouponCode}`);
        }
        if (surveyData.issuedCoupons && surveyData.issuedCoupons.length > 0) {
            console.log(`Survey ${surveyData.surveyId} issued ${surveyData.issuedCoupons.length} coupons: ${surveyData.issuedCoupons.join(', ')}`);
        }
        
        console.log(`Survey ${surveyData.surveyId} uploaded successfully from facility ${facility.name}`);
        
        // Return success response
        res.json({
            status: 'success',
            message: 'Survey uploaded successfully',
            data: {
                survey_id: surveyData.surveyId,
                upload_id: uploadId || 'file-only',
                uploaded_at: new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error('Error uploading survey:', error);
        
        // Log error in audit log
        if (req.facility) {
            await runAsync(
                `INSERT INTO audit_log (user_id, action, entity_type, entity_id, old_value, timestamp)
                 VALUES (?, ?, ?, ?, ?, datetime('now'))`,
                [
                    `facility_${req.facility.id}`,
                    'survey_upload_error',
                    'error',
                    req.body?.survey?.id || 'unknown',
                    error.message
                ]
            ).catch(console.error);
        }
        
        res.status(500).json({
            status: 'error',
            message: 'Failed to upload survey',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * Get upload statistics for a facility
 * GET /api/sync/survey/upload/stats
 */
router.get('/survey/upload/stats', requireFacilityApiKey, async (req, res) => {
    try {
        const facility = req.facility;
        
        // Get upload statistics
        const stats = await getAsync(
            `SELECT 
                COUNT(*) as total_uploads,
                COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END) as completed,
                COUNT(CASE WHEN status = 'FAILED' THEN 1 END) as failed,
                MIN(upload_time) as first_upload,
                MAX(upload_time) as last_upload
             FROM uploads
             WHERE facility_id = ?`,
            [facility.id]
        );
        
        res.json({
            status: 'success',
            data: {
                facility_id: facility.id,
                facility_name: facility.name,
                statistics: stats
            }
        });
        
    } catch (error) {
        console.error('Error fetching upload stats:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to fetch upload statistics'
        });
    }
});

module.exports = router;