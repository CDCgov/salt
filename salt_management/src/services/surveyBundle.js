/**
 * Builds a survey export bundle (schema_version 1): the surveys row plus its
 * sections, questions, options, survey_messages and test_configurations, in
 * the shape services/surveyImport.js reads back.
 *
 * Used by GET /api/admin/surveys/:id/export and the MCP get_survey tool.
 */

const { getAsync, allAsync } = require('../models/database');
const { SCHEMA_VERSION } = require('./surveyImport');

/**
 * Replaces each audio entry in an audio_files_json string with true, so a
 * caller can see which languages have audio without receiving the audio.
 */
function audioFlags(json) {
    let parsed;
    try { parsed = JSON.parse(json || '{}'); } catch { return '{}'; }
    if (!parsed || typeof parsed !== 'object') return '{}';
    const flags = {};
    for (const [lang, data] of Object.entries(parsed)) {
        if (data) flags[lang] = true;
    }
    return JSON.stringify(flags);
}

/**
 * @param {number} surveyId
 * @param {{host?: string|null, includeAudio?: boolean}} [opts]
 *   includeAudio=false replaces audio with per-language `true` flags.
 * @returns {Promise<object|null>} the bundle, or null when the survey doesn't exist
 */
async function buildSurveyBundle(surveyId, { host = null, includeAudio = true } = {}) {
    const survey = await getAsync('SELECT * FROM surveys WHERE id = ?', [surveyId]);
    if (!survey) return null;
    const sections = await allAsync(
        'SELECT * FROM sections WHERE survey_id = ? ORDER BY section_index', [surveyId]
    );
    const questions = await allAsync(
        'SELECT * FROM questions WHERE survey_id = ? ORDER BY question_index', [surveyId]
    );
    const questionIds = questions.map(q => q.id);
    const options = questionIds.length
        ? await allAsync(
              `SELECT * FROM options WHERE question_id IN (${questionIds.map(() => '?').join(',')}) ORDER BY question_id, option_index`,
              questionIds
          )
        : [];
    const messages = await allAsync(
        'SELECT * FROM survey_messages WHERE survey_id = ? ORDER BY message_key', [surveyId]
    );
    const testConfigs = await allAsync(
        'SELECT * FROM test_configurations WHERE survey_id = ? ORDER BY display_order', [surveyId]
    );

    if (!includeAudio) {
        for (const row of [...questions, ...options, ...messages]) {
            row.audio_files_json = audioFlags(row.audio_files_json);
        }
    }

    return {
        schema_version: SCHEMA_VERSION,
        exported_at: new Date().toISOString(),
        source: {
            survey_name: survey.name,
            survey_version: survey.version,
            host
        },
        survey,
        sections,
        questions,
        options,
        survey_messages: messages,
        test_configurations: testConfigs
    };
}

module.exports = { buildSurveyBundle, audioFlags };
