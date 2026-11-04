/**
 * SALT MCP server entry point (reports, survey editing, lab tests). Enabled by
 * default; set MCP_ENABLED to a falsy value (false/0/no/off) to disable it.
 *
 * Usage from app.js (before the catch-all 404 handler):
 *   require('./mcp').init(app).finally(startServerAndFallbacks)
 */

const { mountMcp } = require('./server');

const DISABLED_VALUES = new Set(['false', '0', 'no', 'off']);

async function init(app) {
    const v = String(process.env.MCP_ENABLED ?? '').trim().toLowerCase();
    if (DISABLED_VALUES.has(v)) {
        console.log('[mcp] disabled (MCP_ENABLED=' + process.env.MCP_ENABLED + ')');
        return false;
    }
    await mountMcp(app);
    return true;
}

module.exports = { init };
