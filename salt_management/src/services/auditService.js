const { runAsync } = require('../models/database');
const fs = require('fs').promises;
const path = require('path');
const { redactSecrets } = require('./redact');

async function logAudit(userId, action, entityType, entityId, oldValue, newValue) {
    // Never store passwords, API keys or other secrets in the audit trail.
    oldValue = redactSecrets(oldValue);
    newValue = redactSecrets(newValue);
    try {
        // Log to database
        await runAsync(
            `INSERT INTO audit_log (user_id, action, entity_type, entity_id, old_value, new_value) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, action, entityType, entityId, 
             oldValue ? JSON.stringify(oldValue) : null,
             newValue ? JSON.stringify(newValue) : null]
        );

        // Also log to file for extra safety
        const date = new Date();
        const yearMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        const dirPath = path.join(__dirname, '..', '..', 'data', 'audit', yearMonth);
        
        await fs.mkdir(dirPath, { recursive: true });
        
        const filename = `audit_${date.toISOString().split('T')[0]}.jsonl`;
        const filePath = path.join(dirPath, filename);
        
        const logEntry = {
            timestamp: date.toISOString(),
            userId,
            action,
            entityType,
            entityId,
            oldValue,
            newValue
        };
        
        await fs.appendFile(filePath, JSON.stringify(logEntry) + '\n');
        
    } catch (error) {
        console.error('Audit logging error:', error);
        // Don't throw - audit failures shouldn't break operations
    }
}

module.exports = {
    logAudit
};