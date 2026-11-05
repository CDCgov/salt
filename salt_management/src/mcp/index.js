/**
 * SALT MCP server entry point (reports, survey editing, lab tests). Always
 * mounted; what it offers is controlled at runtime by the switches on the
 * System page (/admin/system, services/systemSettings.js).
 *
 * Usage from app.js (before the catch-all 404 handler):
 *   require('./mcp').init(app).finally(startServerAndFallbacks)
 */

const { mountMcp } = require('./server');

async function init(app) {
    await mountMcp(app);
    return true;
}

module.exports = { init };
