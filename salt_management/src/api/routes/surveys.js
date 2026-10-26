const express = require('express');
const path = require('path');
const { isSafeId, safeJoin } = require('../../utils/safeIds');
const fs = require('fs').promises;
const { body, validationResult } = require('express-validator');
const { getAsync, runAsync, allAsync } = require('../../models/database');
const { validateApiKey } = require('../middleware/auth');
const { logAudit } = require('../../services/auditService');
const router = express.Router();

// Helper to ensure directory exists
async function ensureDir(dirPath) {
    try {
        await fs.mkdir(dirPath, { recursive: true });
    } catch (error) {
        console.error('Error creating directory:', error);
    }
}

// Upload survey from tablet (requires API key)
router.post('/', validateApiKey, [
    body('surveyId').notEmpty().custom(isSafeId),
    body('surveyVersion').isInt(),
    body('participantId').optional(),
    body('responses').isArray(),
    body('metadata').isObject()
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    const { surveyId, surveyVersion, participantId, responses, metadata } = req.body;
    const facilityId = req.facility.id; // Set by validateApiKey middleware

    try {
        // Create file path for survey data
        const date = new Date();
        const yearMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        const dirPath = path.join(__dirname, '..', '..', '..', 'data', 'surveys', yearMonth);
        await ensureDir(dirPath);

        const timestamp = date.toISOString().replace(/[:.]/g, '-');
        const filename = `${surveyId}_${timestamp}.json`;
        const filePath = safeJoin(dirPath, filename);

        // Prepare survey data
        const surveyData = {
            surveyId,
            surveyVersion,
            participantId,
            facilityId,
            facilityName: req.facility.name,
            uploadTime: date.toISOString(),
            responses,
            metadata: {
                ...metadata,
                serverReceived: date.toISOString()
            }
        };

        // Save to file
        await fs.writeFile(filePath, JSON.stringify(surveyData, null, 2));

        // Record upload in database
        const result = await runAsync(
            `INSERT INTO uploads (survey_response_id, facility_id, file_path, status, participant_id) 
             VALUES (?, ?, ?, ?, ?)`,
            [surveyId, facilityId, filePath, 'completed', participantId]
        );

        // Log audit
        await logAudit(null, 'SURVEY_UPLOAD', 'survey', surveyId, null, filePath);

        res.json({
            success: true,
            message: 'Survey uploaded successfully',
            uploadId: result.id,
            surveyId
        });

    } catch (error) {
        console.error('Survey upload error:', error);
        
        // Try to record failed upload
        try {
            await runAsync(
                `INSERT INTO uploads (survey_response_id, facility_id, status, participant_id) 
                 VALUES (?, ?, ?, ?)`,
                [surveyId, facilityId, 'failed', participantId]
            );
        } catch (dbError) {
            console.error('Failed to record upload failure:', dbError);
        }

        res.status(500).json({ error: 'Upload failed' });
    }
});

// Get current survey configuration (for tablets)
router.get('/config', validateApiKey, async (req, res) => {
    try {
        // Get active survey
        const survey = await getAsync(
            'SELECT * FROM surveys WHERE is_active = 1 ORDER BY version DESC LIMIT 1'
        );

        if (!survey) {
            return res.status(404).json({ error: 'No active survey configured' });
        }

        // Get questions
        const questions = await allAsync(
            `SELECT * FROM questions WHERE survey_id = ? ORDER BY question_index`,
            [survey.id]
        );

        // Get options for each question
        const questionsWithOptions = await Promise.all(
            questions.map(async (question) => {
                const options = await allAsync(
                    'SELECT * FROM options WHERE question_id = ? ORDER BY option_index',
                    [question.id]
                );
                return { ...question, options };
            })
        );

        res.json({
            survey: {
                id: survey.id,
                version: survey.version,
                name: survey.name,
                description: survey.description
            },
            questions: questionsWithOptions
        });

    } catch (error) {
        console.error('Error fetching survey config:', error);
        res.status(500).json({ error: 'Failed to fetch survey configuration' });
    }
});

// Get upload status for a facility (for tablets to check their uploads)
router.get('/upload-status', validateApiKey, async (req, res) => {
    const facilityId = req.facility.id;

    try {
        const uploads = await allAsync(
            `SELECT survey_response_id, status, upload_time 
             FROM uploads 
             WHERE facility_id = ? 
             ORDER BY upload_time DESC 
             LIMIT 100`,
            [facilityId]
        );

        res.json({ uploads });

    } catch (error) {
        console.error('Error fetching upload status:', error);
        res.status(500).json({ error: 'Failed to fetch upload status' });
    }
});

module.exports = router;