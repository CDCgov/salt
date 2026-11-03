const express = require('express');
const router = express.Router();
const { allAsync, getAsync } = require('../../models/database');
const { requireAdmin } = require('../../middleware/auth');
const DataExporter = require('../../services/dataExporter');

/**
 * Export survey data in long format (one row per variable)
 * GET /api/admin/export/long
 */
router.get('/export/long', requireAdmin, async (req, res) => {
    try {
        const { preview } = req.query;
        const exporter = new DataExporter({ forSpreadsheet: true });

        // For now, DataExporter doesn't support filtering, so we'll use the full export
        // TODO: Add filtering support to DataExporter
        const csvData = await exporter.exportLongFormat();

        if (preview === 'true') {
            // Parse CSV for preview
            const lines = csvData.split('\n');
            const headers = lines[0].split(',');
            const dataLines = lines.slice(1, 101); // First 100 rows

            const rows = dataLines.map(line => {
                const values = line.match(/(".*?"|[^,]+)/g) || [];
                const row = {};
                headers.forEach((header, index) => {
                    let value = values[index] || '';
                    // Remove quotes if present
                    if (value.startsWith('"') && value.endsWith('"')) {
                        value = value.slice(1, -1).replace(/""/g, '"');
                    }
                    row[header] = value;
                });
                return row;
            });

            res.json({
                count: lines.length - 1,
                preview: rows,
                columns: headers
            });
        } else {
            // Set response headers for CSV download
            const date = new Date().toISOString().split('T')[0];
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="salt_export_long_${date}.csv"`);

            // Add UTF-8 BOM for Excel compatibility
            res.write('\ufeff');
            res.write(csvData);
            res.end();
        }

    } catch (error) {
        console.error('Error exporting data in long format:', error);
        res.status(500).json({ error: 'Failed to export data' });
    }
});

/**
 * Export survey data in wide format (one row per survey) - SIMPLIFIED VERSION
 * GET /api/admin/export/wide
 */
router.get('/export/wide', requireAdmin, async (req, res) => {
    try {
        const { preview, valueType } = req.query;
        const exporter = new DataExporter({ forSpreadsheet: true });

        // Use the shared exporter
        const csvData = await exporter.exportWideFormat(valueType || 'numeric');

        if (preview === 'true') {
            // Parse CSV for preview
            const lines = csvData.split('\n');
            const headers = lines[0].split(',');
            const dataLines = lines.slice(1, 11); // First 10 rows

            const rows = dataLines.map(line => {
                const values = line.match(/(".*?"|[^,]+)/g) || [];
                const row = {};
                headers.forEach((header, index) => {
                    let value = values[index] || '';
                    // Remove quotes if present
                    if (value.startsWith('"') && value.endsWith('"')) {
                        value = value.slice(1, -1).replace(/""/g, '"');
                    }
                    row[header] = value;
                });
                return row;
            });

            res.json({
                count: lines.length - 1,
                preview: rows,
                columns: headers
            });
        } else {
            // Set response headers for CSV download
            const date = new Date().toISOString().split('T')[0];
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="salt_export_wide_${date}.csv"`);

            // Add UTF-8 BOM for Excel compatibility
            res.write('\ufeff');
            res.write(csvData);
            res.end();
        }

    } catch (error) {
        console.error('Error exporting data in wide format:', error);
        res.status(500).json({ error: 'Failed to export data' });
    }
});

/**
 * Export the survey data dictionary (one row per export variable) as CSV.
 * GET /api/admin/export/data-dictionary?surveyId=<id>
 * surveyId is optional; defaults to the active survey (else the most recent).
 */
router.get('/export/data-dictionary', requireAdmin, async (req, res) => {
    try {
        const { generateDictionaryCsv } = require('../../services/dataDictionary');

        let surveyId = req.query.surveyId ? parseInt(req.query.surveyId, 10) : null;
        if (!surveyId) {
            const s = await getAsync('SELECT id FROM surveys WHERE is_active = 1 ORDER BY id DESC LIMIT 1')
                || await getAsync('SELECT id FROM surveys ORDER BY id DESC LIMIT 1');
            surveyId = s ? s.id : null;
        }
        if (!surveyId) return res.status(404).json({ error: 'No survey found' });

        const csvData = await generateDictionaryCsv(surveyId, { forSpreadsheet: true });
        const date = new Date().toISOString().split('T')[0];
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="salt_data_dictionary_survey${surveyId}_${date}.csv"`);
        res.write('\ufeff'); // UTF-8 BOM for Excel
        res.write(csvData);
        res.end();
    } catch (error) {
        if (error.code === 'SURVEY_NOT_FOUND') {
            return res.status(404).json({ error: 'Survey not found' });
        }
        console.error('Error exporting data dictionary:', error);
        res.status(500).json({ error: 'Failed to export data dictionary' });
    }
});

module.exports = router;