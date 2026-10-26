/**
 * Device Log Upload Routes
 *
 * Handles device log uploads from Android tablets. Saves log text as
 * human-readable .txt files with a metadata header.
 *
 * Data Flow:
 * 1. Tablet sends POST request with JSON containing logId, logs, deviceInfo, logDate
 * 2. Validate facility authentication via API key
 * 3. Check for duplicate logId (prevent re-processing)
 * 4. Save as plain text to /data/uploads/device_logs/
 * 5. Return success response to tablet
 *
 * Authentication:
 * - Requires facility API key via Bearer token
 * - Validated by requireFacilityApiKey middleware
 *
 * API Endpoints:
 * - POST /api/sync/logs/upload: Upload device log file
 *
 * @module api/routes/logUpload
 */

const express = require('express');
const path = require('path');
const { isSafeId, safeJoin } = require('../../utils/safeIds');
const fs = require('fs').promises;
const { runAsync } = require('../../models/database');
const { requireFacilityApiKey } = require('../../web/middleware/auth');
const router = express.Router();

// Track uploaded log IDs in memory to quickly detect duplicates
const recentLogIds = new Set();

/**
 * Upload device logs from facility tablet
 * POST /api/sync/logs/upload
 */
router.post('/logs/upload', requireFacilityApiKey, async (req, res) => {
    try {
        const facility = req.facility;
        const { logId, logs, deviceInfo, logDate } = req.body;

        console.log('Received device log upload:', {
            logId,
            facility: facility.name,
            logDate,
            logLength: logs ? logs.length : 0
        });

        // Validate required fields
        if (!logId) {
            return res.status(400).json({
                status: 'error',
                message: 'Invalid log data: missing logId'
            });
        }
        // The log ID becomes part of a file name; tablets send "LOG_<uuid>".
        if (!isSafeId(logId)) {
            return res.status(400).json({
                status: 'error',
                message: 'Invalid log data: malformed logId'
            });
        }

        if (!logs) {
            return res.status(400).json({
                status: 'error',
                message: 'Invalid log data: missing logs'
            });
        }

        // Check for duplicate in memory cache
        if (recentLogIds.has(logId)) {
            console.log(`Device log ${logId} already uploaded (cache hit)`);
            return res.json({
                status: 'success',
                message: 'Log already uploaded',
                duplicate: true
            });
        }

        // Check for duplicate on disk
        const uploadsDir = path.join(__dirname, '..', '..', '..', 'data', 'uploads', 'device_logs');
        await fs.mkdir(uploadsDir, { recursive: true });

        try {
            const files = await fs.readdir(uploadsDir);
            const existingFile = files.find(f => f.includes(logId));
            if (existingFile) {
                console.log(`Device log ${logId} already uploaded (file exists)`);
                recentLogIds.add(logId);
                return res.json({
                    status: 'success',
                    message: 'Log already uploaded',
                    duplicate: true
                });
            }
        } catch (err) {
            // Directory might not exist yet, that's fine
        }

        // Generate filename
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `log_${facility.id}_${timestamp}_${logId}.txt`;

        // Build plain-text file content with metadata header
        const info = deviceInfo || {};
        const fileContent = [
            '========================================',
            'SALT Device Log Upload',
            '========================================',
            `Facility: ${facility.name} (ID: ${facility.id})`,
            `Location: ${facility.location || 'N/A'}`,
            `Log Date: ${logDate || 'N/A'}`,
            `Upload Date: ${new Date().toISOString()}`,
            `Device: ${info.deviceModel || 'N/A'}, Android ${info.androidVersion || 'N/A'}, App ${info.appVersion || 'N/A'}`,
            `Device ID: ${info.deviceId || 'N/A'}`,
            '========================================',
            '',
            logs
        ].join('\n');

        // Save to file system
        const filepath = safeJoin(uploadsDir, filename);
        await fs.writeFile(filepath, fileContent, 'utf8');

        // Add to memory cache
        recentLogIds.add(logId);

        // Keep cache from growing indefinitely
        if (recentLogIds.size > 1000) {
            const iterator = recentLogIds.values();
            recentLogIds.delete(iterator.next().value);
        }

        // Log to audit trail
        try {
            await runAsync(
                `INSERT INTO audit_log (user_id, action, entity_type, entity_id, new_value, timestamp)
                 VALUES (?, ?, ?, ?, ?, datetime('now'))`,
                [
                    `facility_${facility.id}`,
                    'device_log_upload',
                    'device_log',
                    logId,
                    JSON.stringify({
                        facility: facility.name,
                        logDate: logDate || null,
                        deviceModel: info.deviceModel || null,
                        logSize: logs.length
                    })
                ]
            );
        } catch (auditError) {
            console.error('Failed to log device log upload to audit trail:', auditError);
        }

        console.log(`Device log ${logId} uploaded successfully from facility ${facility.name} (${logs.length} chars)`);

        res.json({
            status: 'success',
            message: 'Device log uploaded successfully',
            data: {
                log_id: logId,
                uploaded_at: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('Error uploading device log:', error);

        if (req.facility) {
            try {
                await runAsync(
                    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, old_value, timestamp)
                     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
                    [
                        `facility_${req.facility.id}`,
                        'device_log_upload_error',
                        'error',
                        req.body?.logId || 'unknown',
                        error.message
                    ]
                );
            } catch (auditError) {
                console.error('Failed to log error to audit trail:', auditError);
            }
        }

        res.status(500).json({
            status: 'error',
            message: 'Failed to upload device log',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

module.exports = router;
