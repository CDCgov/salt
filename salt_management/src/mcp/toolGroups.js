/**
 * toolGroups.js — MCP tools grouped by the System page switch that controls them.
 *
 *   reports  — report building (mcp_reports_enabled)
 *   surveys  — survey and lab test editing (mcp_survey_editing_enabled)
 *   any      — shared read-only tools (list_surveys), on when either group is
 *
 * server.js builds a fresh MCP server per request and registers only the groups
 * that are on. Clients may cache the tool list, so every tool also checks its
 * switch when it is called and refuses if it has been turned off since.
 */

const systemSettings = require('../services/systemSettings');

const OFF_MESSAGE = 'This feature has been turned off by an administrator (System page in the SALT web app).';

function groupOn(groups, group) {
    return group === 'any' ? (groups.reports || groups.surveys) : !!groups[group];
}

/**
 * A stand-in for server.registerTool that registers only when the group is
 * on (`groups` = the switches at the start of this request) and wraps each
 * handler with a call-time check.
 */
function groupRegistrar(server, group, groups) {
    return {
        registerTool(name, definition, handler) {
            if (!groupOn(groups, group)) return;
            server.registerTool(name, definition, async (args, extra) => {
                if (!groupOn(await systemSettings.mcpGroups(), group)) {
                    return { content: [{ type: 'text', text: OFF_MESSAGE }], isError: true };
                }
                return handler(args, extra);
            });
        }
    };
}

module.exports = { groupRegistrar, groupOn, OFF_MESSAGE };
