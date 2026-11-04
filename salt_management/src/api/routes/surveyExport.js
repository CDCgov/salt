/**
 * Survey Export / Import
 *
 *   GET  /api/admin/surveys/:id/export   → JSON file download
 *   POST /api/admin/surveys/import       → JSON body, creates a new survey
 *
 * Export includes everything needed to re-create the survey on another
 * deployment: the surveys row, sections, questions, options, survey_messages,
 * and test_configurations. Audio is embedded as base64 in the same
 * `audio_files_json` shape the database uses, so the file is self-contained.
 *
 * NOT included: lab_test_configurations (global to the deployment),
 * facilities, admin users, completed survey data, coupons, audit logs.
 *
 * Import always creates a brand new survey row (is_active=0, is_draft=1).
 * Internal IDs (survey/section/question/option) are reassigned on insert and
 * references within the bundle are remapped accordingly. There is no in-place
 * overwrite path — that would require diff/merge logic that isn't worth the
 * risk for v1.
 */

const express = require('express');
const { getAsync, allAsync, runAsync } = require('../../models/database');
const { requireAdmin } = require('../../middleware/auth');
const { logAudit } = require('../../services/auditService');
const { importSurveyBundle } = require('../../services/surveyImport');
const { buildSurveyBundle } = require('../../services/surveyBundle');
const database = require('../../models/database');
const { checkSurvey } = require('../../services/jexlCheck');
const router = express.Router();

function safeFilename(s) {
    return String(s || 'survey').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);
}

router.get('/admin/surveys/:id/export', requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id)) {
            return res.status(400).json({ status: 'error', message: 'Invalid survey id' });
        }

        const bundle = await buildSurveyBundle(id, { host: req.get('host') || null });
        if (!bundle) {
            return res.status(404).json({ status: 'error', message: 'Survey not found' });
        }
        const { survey, questions, survey_messages: messages } = bundle;

        const filename = `salt-survey_${safeFilename(survey.name)}_v${survey.version}_${new Date().toISOString().slice(0, 10)}.json`;

        await logAudit(
            req.user ? req.user.id : null,
            'EXPORT_SURVEY',
            'survey',
            String(id),
            null,
            { survey_id: id, name: survey.name, version: survey.version,
              questions: questions.length, messages: messages.length }
        );

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(JSON.stringify(bundle, null, 2));
    } catch (err) {
        console.error('Survey export error:', err);
        res.status(500).json({ status: 'error', message: 'Failed to export survey' });
    }
});

router.post('/admin/surveys/import', requireAdmin, async (req, res) => {
    // Core import logic lives in services/surveyImport so the fresh-deploy
    // seeder (scripts/init-database.js) shares exactly this code path.
    let result;
    try {
        result = await importSurveyBundle(
            { run: runAsync, all: allAsync },
            req.body
        );
    } catch (err) {
        if (err && err.validation) {
            return res.status(400).json({ status: 'error', message: err.message });
        }
        console.error('Survey import error:', err);
        return res.status(500).json({
            status: 'error',
            message: 'Failed to import survey: ' + (err.message || err)
        });
    }

    // The import already committed — a failed audit write must not 500 it.
    try {
        await logAudit(
            req.user ? req.user.id : null,
            'IMPORT_SURVEY',
            'survey',
            String(result.surveyId),
            null,
            { name: result.name, version: result.version,
              questions: result.counts.questions, sections: result.counts.sections,
              messages: result.counts.survey_messages,
              test_configurations: result.counts.test_configurations,
              source_version: req.body && req.body.survey ? req.body.survey.version : undefined }
        );
    } catch (auditErr) {
        console.error('Audit log for IMPORT_SURVEY failed:', auditErr);
    }

    // Script check report. The import is a draft, so it isn't blocked;
    // activation is blocked until the errors are fixed.
    let jexlCheck = null;
    try {
        jexlCheck = await checkSurvey(database, result.surveyId);
    } catch (checkErr) {
        console.error('JEXL check after import failed:', checkErr);
    }

    res.json({
        status: 'success',
        surveyId: result.surveyId,
        name: result.name,
        version: result.version,
        counts: result.counts,
        warnings: result.warnings,
        jexl_check: jexlCheck
    });
});

module.exports = router;
