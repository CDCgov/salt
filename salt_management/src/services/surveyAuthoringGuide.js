/**
 * surveyAuthoringGuide.js — the survey authoring guide served to AI assistants
 * by the MCP get_survey_authoring_guide tool.
 *
 * Like reportInstructions.js, the text lives in an editable Markdown file:
 *   - the shipped default is src/mcp/survey-authoring.default.md;
 *   - on first use it is seeded into data/reports/survey-authoring.md
 *     (override with MCP_SURVEY_GUIDE_FILE);
 *   - edits to that file take effect on the next read (mtime-cached).
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', 'mcp', 'survey-authoring.default.md');

function guideFilePath() {
    return process.env.MCP_SURVEY_GUIDE_FILE
        || path.join(process.cwd(), 'data', 'reports', 'survey-authoring.md');
}

let cache = { path: null, mtimeMs: -1, text: '' };

function ensureSeeded() {
    const file = guideFilePath();
    if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.copyFileSync(DEFAULT_FILE, file);
    }
    return file;
}

function getSurveyAuthoringGuide() {
    try {
        const file = ensureSeeded();
        const { mtimeMs } = fs.statSync(file);
        if (cache.path === file && cache.mtimeMs === mtimeMs) return cache.text;
        const text = fs.readFileSync(file, 'utf8');
        cache = { path: file, mtimeMs, text };
        return text;
    } catch {
        try { return fs.readFileSync(DEFAULT_FILE, 'utf8'); } catch { return ''; }
    }
}

module.exports = { getSurveyAuthoringGuide, guideFilePath, ensureSeeded, DEFAULT_FILE };
