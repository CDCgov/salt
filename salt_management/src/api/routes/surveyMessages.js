const express = require('express');
const editing = require('../../services/surveyEditing');
const router = express.Router();
const { requireAdmin } = require('../../middleware/auth');
const { getAsync, runAsync, allAsync } = require('../../models/database');
const { logAudit } = require('../../services/auditService');

// All routes in this file require admin authentication
router.use(requireAdmin);

// Get all messages for a survey
router.get('/:surveyId/messages', async (req, res) => {
    try {
        const surveyId = req.params.surveyId;

        const messages = await allAsync(
            `SELECT id, message_key, display_order, message_text_json, audio_files_json, message_type, created_at, updated_at
             FROM survey_messages
             WHERE survey_id = ?
             ORDER BY display_order, message_key`,
            [surveyId]
        );

        // Parse JSON fields
        const parsedMessages = messages.map(msg => ({
            ...msg,
            message_text_json: JSON.parse(msg.message_text_json || '{}'),
            audio_files_json: JSON.parse(msg.audio_files_json || '{}')
        }));

        res.json(parsedMessages);
    } catch (error) {
        console.error('Error fetching messages:', error);
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

// Get a specific message
router.get('/:surveyId/messages/:messageKey', async (req, res) => {
    try {
        const { surveyId, messageKey } = req.params;

        const message = await getAsync(
            `SELECT * FROM survey_messages WHERE survey_id = ? AND message_key = ?`,
            [surveyId, messageKey]
        );

        if (!message) {
            return res.status(404).json({ error: 'Message not found' });
        }

        message.message_text_json = JSON.parse(message.message_text_json || '{}');
        message.audio_files_json = JSON.parse(message.audio_files_json || '{}');

        res.json(message);
    } catch (error) {
        console.error('Error fetching message:', error);
        res.status(500).json({ error: 'Failed to fetch message' });
    }
});

// Update a message (create if doesn't exist)
router.put('/:surveyId/messages/:messageKey', async (req, res) => {
    try {
        const { surveyId, messageKey } = req.params;
        const { message_text_json, audio_files_json, message_type, display_order } = req.body;

        // The editor sends the full audio map on every save, so it replaces the stored one.
        const message = await editing.setMessage(surveyId, messageKey, {
            text: message_text_json,
            audio: audio_files_json,
            messageType: message_type,
            displayOrder: display_order || 0
        }, { userId: req.session && req.session.userId, via: 'web' }, { replaceAudio: true });

        message.message_text_json = JSON.parse(message.message_text_json || '{}');
        message.audio_files_json = JSON.parse(message.audio_files_json || '{}');
        res.json(message);
    } catch (error) {
        if (error instanceof editing.EditError) {
            return res.status(error.status).json({ error: error.message });
        }
        console.error('Error updating message:', error);
        res.status(500).json({ error: 'Failed to update message' });
    }
});

// Delete a custom message (only non-system messages can be deleted)
router.delete('/:surveyId/messages/:messageKey', async (req, res) => {
    try {
        const { surveyId, messageKey } = req.params;

        // Check if it's a system message
        const message = await getAsync(
            `SELECT message_type FROM survey_messages WHERE survey_id = ? AND message_key = ?`,
            [surveyId, messageKey]
        );

        if (!message) {
            return res.status(404).json({ error: 'Message not found' });
        }

        if (message.message_type === 'system') {
            return res.status(400).json({ error: 'Cannot delete system messages' });
        }

        // Delete the message
        await runAsync(
            `DELETE FROM survey_messages WHERE survey_id = ? AND message_key = ?`,
            [surveyId, messageKey]
        );

        // Log the action (use session userId since req.user isn't populated)
        if (req.session && req.session.userId) {
            await logAudit(req.session.userId, 'DELETE_MESSAGE', {
                surveyId,
                messageKey
            });
        }

        res.json({ success: true, message: 'Message deleted' });
    } catch (error) {
        console.error('Error deleting message:', error);
        res.status(500).json({ error: 'Failed to delete message' });
    }
});

module.exports = router;