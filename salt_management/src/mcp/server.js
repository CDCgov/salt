/**
 * server.js — mounts the SALT MCP server (reports, survey editing, lab tests)
 * onto the existing Express app.
 *
 * Self-contained: everything lives under src/mcp/, gated by MCP_ENABLED, and is
 * mounted with a single call from app.js. The MCP SDK is ESM, so it is loaded
 * via dynamic import() from this CommonJS module.
 *
 * Transport: Streamable HTTP in stateless mode (a fresh McpServer + transport
 * per request) — simplest correct model for an authenticated, request/response
 * tool API. Auth: bearer tokens verified against mcp_sessions (sessionStore),
 * issued by the OAuth server (oauth.js) or the local mint script.
 */

const { verifyAccessToken } = require('./sessionStore');
const { registerTools } = require('./tools');

const SERVER_INFO = { name: 'salt', version: '0.2.0' };

/**
 * Mount MCP endpoints on the app. Returns true if mounted.
 * @param {import('express').Express} app
 */
async function mountMcp(app) {
    const express = require('express');
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const { requireBearerAuth } = await import('@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js');
    const { InvalidTokenError } = await import('@modelcontextprotocol/sdk/server/auth/errors.js');

    // Public base URL (for OAuth issuer / resource metadata). Falls back to localhost.
    const baseUrl = process.env.MCP_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;

    // Bearer verifier backed by our session store.
    const verifier = {
        async verifyAccessToken(token) {
            const info = await verifyAccessToken(token);
            if (!info) throw new InvalidTokenError('Token is invalid, expired, or revoked');
            return info;
        },
    };

    // OAuth 2.1 authorization server (discovery, register, authorize, token,
    // revoke). Wired in a separate module to keep the protocol plumbing apart.
    let resourceMetadataUrl;
    try {
        const { mountOAuth } = require('./oauth');
        resourceMetadataUrl = await mountOAuth(app, { baseUrl });
    } catch (e) {
        console.warn('[mcp] OAuth server not mounted:', e.message);
    }

    const bearer = requireBearerAuth({ verifier, requiredScopes: [], resourceMetadataUrl });

    // Dedicated JSON parser for /mcp (mirrors the global 50mb limit) so this
    // module is self-contained even if global parsers change.
    const jsonParser = express.json({ limit: '50mb' });

    // Stateless handler: new server + transport per request.
    app.post('/mcp', jsonParser, bearer, async (req, res) => {
        const server = new McpServer(SERVER_INFO, {
            capabilities: { tools: {} },
            // Short bootstrap that forces the agent to fetch the full guidance
            // (get_report_instructions / get_survey_authoring_guide) first.
            instructions: require('../services/reportInstructions').BOOTSTRAP_INSTRUCTIONS,
        });
        registerTools(server);

        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => { transport.close(); server.close(); });

        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (err) {
            console.error('[mcp] request error:', err);
            if (!res.headersSent) {
                res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
            }
        }
    });

    // Stateless mode has no server->client stream / session teardown.
    const methodNotAllowed = (req, res) => res.status(405).json({
        jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server).' }, id: null,
    });
    app.get('/mcp', bearer, methodNotAllowed);
    app.delete('/mcp', bearer, methodNotAllowed);

    // Seed the editable instructions file (if absent) and surface its path so
    // operators know where to tune the report guidance.
    try {
        const ri = require('../services/reportInstructions');
        ri.ensureSeeded();
        console.log(`[mcp] report instructions (editable): ${ri.instructionsFilePath()}`);
    } catch (e) {
        console.warn('[mcp] could not seed report instructions:', e.message);
    }

    try {
        const guide = require('../services/surveyAuthoringGuide');
        guide.ensureSeeded();
        console.log(`[mcp] survey authoring guide (editable): ${guide.guideFilePath()}`);
    } catch (e) {
        console.warn('[mcp] could not seed survey authoring guide:', e.message);
    }

    // Seed the example report templates into the data volume (it is
    // dockerignored/gitignored, so they ship as defaults and are copied in).
    try {
        require('./tools').seedTemplates();
    } catch (e) {
        console.warn('[mcp] could not seed templates:', e.message);
    }

    console.log(`[mcp] SALT MCP server (reports, surveys, lab tests) mounted at ${baseUrl}/mcp`);
    return true;
}

module.exports = { mountMcp };
