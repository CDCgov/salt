/**
 * reportInstructions.js — single source of truth for the report-generation
 * system prompt ("instructions").
 *
 * The text lives in an **editable Markdown file** so operators can tune the
 * guidance without a code change:
 *   - A shipped default ships with the code (report-instructions.default.md).
 *   - On first use it is seeded into the persistent data volume at
 *     data/reports/report-instructions.md (override with MCP_INSTRUCTIONS_FILE).
 *   - Edits to that file take effect on the next read (mtime-cached).
 *
 * Consumed by the MCP server (advertised `instructions`, the
 * `get_report_instructions` tool) and the `/instructions` endpoint, so the
 * guidance an agent receives never drifts between channels. The instructions
 * are general (not survey-specific) — like an AGENTS.md.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', 'mcp', 'report-instructions.default.md');

// Short, forceful directive advertised as the MCP server's `instructions`. Kept
// separate from (and shorter than) the full guidance so it is unmissable: it
// compels the agent to fetch the full instructions before doing any analysis.
const REPORT_BOOTSTRAP =
    'For report work, your FIRST action MUST be to call the `get_report_instructions` tool and ' +
    'follow what it returns — do this before reading data, writing any R/Quarto, or calling any ' +
    'other report tool. It contains the data contract, exact variable naming, data-cleaning rules, ' +
    'available R packages, and output requirements; without it the analysis will be wrong.';
const SURVEY_BOOTSTRAP =
    'For creating or editing surveys or lab tests, your FIRST action MUST be to call ' +
    '`get_survey_authoring_guide` and follow it: survey logic has rules that are easy to get wrong.';

/**
 * The MCP server's advertised instructions, naming only the tool groups that
 * are switched on (System page), so the AI isn't told about tools it can't use.
 */
function buildBootstrapInstructions({ reports = true, surveys = true } = {}) {
    const offered = [reports && 'reports', surveys && 'survey and lab test editing'].filter(Boolean);
    return [
        `You are connected to the SALT server (MCP): ${offered.join(', and ')}.`,
        reports ? REPORT_BOOTSTRAP : 'Report building is turned off on this server.',
        surveys ? SURVEY_BOOTSTRAP : 'Survey and lab test editing is turned off on this server.'
    ].join(' ');
}

// With every group on (kept for callers that don't know the switches).
const BOOTSTRAP_INSTRUCTIONS = buildBootstrapInstructions();

/** Path to the editable instructions file (env-overridable). */
function instructionsFilePath() {
    return process.env.MCP_INSTRUCTIONS_FILE
        || path.join(process.cwd(), 'data', 'reports', 'report-instructions.md');
}

let cache = { path: null, mtimeMs: -1, text: '' };

/** Ensure the editable file exists (seed from the shipped default once). */
function ensureSeeded() {
    const file = instructionsFilePath();
    if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.copyFileSync(DEFAULT_FILE, file);
    }
    return file;
}

/** Load the template text, re-reading only when the file changes. */
function loadTemplate() {
    let file;
    try {
        file = ensureSeeded();
        const { mtimeMs } = fs.statSync(file);
        if (cache.path === file && cache.mtimeMs === mtimeMs) return cache.text;
        const text = fs.readFileSync(file, 'utf8');
        cache = { path: file, mtimeMs, text };
        return text;
    } catch (e) {
        // Fall back to the shipped default if the editable file is unreadable.
        try { return fs.readFileSync(DEFAULT_FILE, 'utf8'); } catch { return ''; }
    }
}

/**
 * @returns {string} the general report-generation instructions (markdown)
 */
function getReportInstructions() {
    // Defensive: strip any leftover {{SURVEY}} token an operator might add.
    return loadTemplate().replace(/\{\{SURVEY\}\}/g, 'a SALT survey');
}

module.exports = { getReportInstructions, instructionsFilePath, ensureSeeded, DEFAULT_FILE, BOOTSTRAP_INSTRUCTIONS, buildBootstrapInstructions };
