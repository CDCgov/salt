/**
 * sessionStore.js — issue / verify / refresh / revoke MCP access tokens.
 *
 * Tokens live in the `mcp_sessions` table (hashed, never stored in clear).
 * Enforces an ABSOLUTE 6-hour session cap: `absolute_expires_at` is set at
 * issuance and refresh is refused past it, regardless of the (shorter)
 * access-token lifetime. Revocation is immediate via the `revoked` flag.
 *
 * Shared by the OAuth server (production claude.ai flow) and the local
 * token-mint script used for testing — both produce rows here, and
 * `verifyAccessToken` is the single gate used by the MCP bearer middleware.
 */

const crypto = require('crypto');
const { runAsync, getAsync, allAsync } = require('../models/database');

const ACCESS_TTL_SECONDS = parseInt(process.env.MCP_ACCESS_TTL_SECONDS || '1800', 10);    // 30 min
const SESSION_MAX_SECONDS = parseInt(process.env.MCP_SESSION_MAX_SECONDS || '21600', 10); // 6 h hard cap

function randomToken() {
    return crypto.randomBytes(32).toString('base64url');
}
function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}
function isoIn(seconds) {
    return new Date(Date.now() + seconds * 1000).toISOString();
}
function past(iso) {
    return !iso || Date.now() > new Date(iso).getTime();
}

// Tokens are only valid while their user is an active administrator, so
// deactivating or demoting a user cuts off MCP access on the next request.
async function userStillAllowed(userId) {
    const u = await getAsync('SELECT role, is_active FROM admin_users WHERE id = ?', [userId]);
    return !!(u && u.is_active && u.role === 'administrator');
}

/**
 * Create a new session for a user. Returns clear tokens (only time they exist).
 * @param {{userId:number, clientId?:string, scope?:string}} opts
 */
async function createSession({ userId, clientId = null, scope = 'mcp' }) {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const accessExpires = isoIn(ACCESS_TTL_SECONDS);
    const absoluteExpires = isoIn(SESSION_MAX_SECONDS);

    await runAsync(
        `INSERT INTO mcp_sessions
           (user_id, client_id, access_token_hash, refresh_token_hash, scope,
            issued_at, access_expires_at, absolute_expires_at, last_used_at, revoked)
         VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, datetime('now'), 0)`,
        [userId, clientId, hashToken(accessToken), hashToken(refreshToken), scope, accessExpires, absoluteExpires]
    );

    return {
        accessToken,
        refreshToken,
        expiresIn: ACCESS_TTL_SECONDS,
        scope,
        absoluteExpiresAt: absoluteExpires,
    };
}

/**
 * Verify an access token. Returns an AuthInfo-shaped object or null.
 * Side effect: bumps last_used_at on success.
 */
async function verifyAccessToken(token) {
    if (!token) return null;
    const row = await getAsync(
        'SELECT * FROM mcp_sessions WHERE access_token_hash = ?',
        [hashToken(token)]
    );
    if (!row) return null;
    if (row.revoked) return null;
    if (past(row.access_expires_at)) return null;
    if (past(row.absolute_expires_at)) return null;   // absolute 6h cap
    if (!(await userStillAllowed(row.user_id))) return null;

    await runAsync('UPDATE mcp_sessions SET last_used_at = datetime(\'now\') WHERE id = ?', [row.id]);

    return {
        token,
        clientId: row.client_id || 'mcp',
        scopes: (row.scope || 'mcp').split(' ').filter(Boolean),
        expiresAt: Math.floor(new Date(row.access_expires_at).getTime() / 1000),
        extra: { userId: row.user_id, sessionId: row.id },
    };
}

/**
 * Rotate tokens using a refresh token. Refused once the absolute 6h cap passes.
 * Returns new clear tokens or null if invalid/expired/revoked.
 */
async function refreshSession(refreshToken, clientId = null) {
    if (!refreshToken) return null;
    const row = await getAsync(
        'SELECT * FROM mcp_sessions WHERE refresh_token_hash = ?',
        [hashToken(refreshToken)]
    );
    if (!row || row.revoked) return null;
    if (past(row.absolute_expires_at)) return null;   // hard cap → must re-authenticate
    if (!(await userStillAllowed(row.user_id))) return null;

    const newAccess = randomToken();
    const newRefresh = randomToken();
    // New access token never outlives the absolute cap.
    const cap = new Date(row.absolute_expires_at).getTime();
    const accessExpires = new Date(Math.min(Date.now() + ACCESS_TTL_SECONDS * 1000, cap)).toISOString();

    await runAsync(
        `UPDATE mcp_sessions
           SET access_token_hash = ?, refresh_token_hash = ?, access_expires_at = ?, last_used_at = datetime('now')
         WHERE id = ?`,
        [hashToken(newAccess), hashToken(newRefresh), accessExpires, row.id]
    );

    return {
        accessToken: newAccess,
        refreshToken: newRefresh,
        expiresIn: Math.max(1, Math.floor((new Date(accessExpires).getTime() - Date.now()) / 1000)),
        scope: row.scope || 'mcp',
    };
}

/** Revoke by access or refresh token. */
async function revokeToken(token) {
    if (!token) return;
    const h = hashToken(token);
    await runAsync(
        'UPDATE mcp_sessions SET revoked = 1 WHERE access_token_hash = ? OR refresh_token_hash = ?',
        [h, h]
    );
}

/** Revoke every active session for a user (e.g. "disconnect all"). */
async function revokeAllForUser(userId) {
    await runAsync('UPDATE mcp_sessions SET revoked = 1 WHERE user_id = ?', [userId]);
}

/** Sessions that are not revoked and not past the absolute cap. */
async function countActiveSessions() {
    const rows = await allAsync('SELECT absolute_expires_at FROM mcp_sessions WHERE revoked = 0');
    return rows.filter(r => !past(r.absolute_expires_at)).length;
}

/** Revoke every session (the System page's kill switch). Returns how many were active. */
async function revokeAllSessions() {
    const active = await countActiveSessions();
    await runAsync('UPDATE mcp_sessions SET revoked = 1 WHERE revoked = 0');
    return active;
}

module.exports = {
    ACCESS_TTL_SECONDS,
    SESSION_MAX_SECONDS,
    randomToken,
    hashToken,
    createSession,
    verifyAccessToken,
    refreshSession,
    revokeToken,
    revokeAllForUser,
    countActiveSessions,
    revokeAllSessions,
};
