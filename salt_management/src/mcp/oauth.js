/**
 * oauth.js — self-contained OAuth 2.1 authorization server for the MCP connector
 * (Path B). Backed by the oauth_clients / oauth_auth_codes / mcp_sessions tables.
 *
 * Uses the MCP SDK's `mcpAuthRouter` for the protocol plumbing (discovery
 * metadata, dynamic client registration, PKCE validation, token + revoke
 * endpoints, built-in rate limiting). We supply the provider: dynamic client
 * store, the authorize() user-consent step (which reuses SALT's existing
 * session login via an MCP-owned consent page — no change to shared login),
 * and token issuance via the shared sessionStore (which enforces the 6h cap).
 */

const { runAsync, getAsync } = require('../models/database');
const sessionStore = require('./sessionStore');
const { ROLES } = require('../constants/roles');
const { mcpGroups } = require('../services/systemSettings');

const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PENDING_TTL_MS = 10 * 60 * 1000;   // how long a consent screen stays valid

// Only active administrators may connect the SALT MCP server.
async function activeAdmin(userId) {
    if (!userId) return null;
    const u = await getAsync(
        'SELECT id, username, role, is_active FROM admin_users WHERE id = ?',
        [userId]
    );
    return (u && u.is_active && u.role === ROLES.ADMINISTRATOR) ? u : null;
}

// SDK OAuth error classes (ESM). Loaded once in mountOAuth(); used so the SDK's
// token handler maps our failures to proper 400 invalid_grant / 401 responses
// instead of a generic 500.
let oauthErrors = null;
function grantError(message) {
    if (oauthErrors && oauthErrors.InvalidGrantError) return new oauthErrors.InvalidGrantError(message);
    return new Error(message);
}
function tokenError(message) {
    if (oauthErrors && oauthErrors.InvalidTokenError) return new oauthErrors.InvalidTokenError(message);
    return new Error(message);
}

// ---- client store ---------------------------------------------------------

const clientsStore = {
    async getClient(clientId) {
        const row = await getAsync('SELECT metadata_json FROM oauth_clients WHERE client_id = ?', [clientId]);
        if (!row) return undefined;
        try { return JSON.parse(row.metadata_json); } catch { return undefined; }
    },

    async registerClient(client) {
        const clientId = sessionStore.randomToken().slice(0, 24);
        const full = {
            ...client,
            client_id: clientId,
            client_id_issued_at: Math.floor(Date.now() / 1000),
            token_endpoint_auth_method: client.token_endpoint_auth_method || 'none',
        };
        await runAsync(
            `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, token_endpoint_auth_method, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                clientId,
                full.client_name || null,
                JSON.stringify(full.redirect_uris || []),
                JSON.stringify(full.grant_types || ['authorization_code', 'refresh_token']),
                full.token_endpoint_auth_method,
                JSON.stringify(full),
            ]
        );
        return full;
    },
};

// ---- provider -------------------------------------------------------------

// The consent page's post-login return target must be this server's own
// /authorize endpoint. Rejects absolute URLs, '//' and backslash forms.
function isLocalAuthorizePath(url) {
    if (typeof url !== 'string' || !url.startsWith('/') || url.includes('\\')) return false;
    try {
        const u = new URL(url, 'http://salt.invalid');
        return u.origin === 'http://salt.invalid' && u.pathname === '/authorize';
    } catch {
        return false;
    }
}

async function issueAuthorizationCode(pending) {
    const code = sessionStore.randomToken();
    const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_MS).toISOString();
    await runAsync(
        `INSERT INTO oauth_auth_codes (code, client_id, user_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [code, pending.clientId, pending.userId, pending.redirectUri,
         pending.codeChallenge, 'S256', pending.scopes.join(' '), expiresAt]
    );
    return code;
}

function redirectWith(redirectUri, params) {
    const url = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
    return url.toString();
}

const provider = {
    get clientsStore() { return clientsStore; },

    /**
     * Authorization step. The SDK has already validated the client and PKCE
     * params; we ensure the browser has an authenticated SALT session and an
     * explicit consent, then redirect back to the client's redirect_uri with a
     * one-time code.
     */
    // Nothing in the authorize URL can grant access. We park the validated
    // request in the user's session under a random id and send the browser to
    // the consent page; a code is issued only when that page POSTs an explicit
    // approval carrying the id (see POST /mcp-consent).
    async authorize(client, params, res) {
        const req = res.req;
        const admin = req.session ? await activeAdmin(req.session.userId) : null;

        if (!admin) {
            // Not signed in, or not an administrator: show sign-in, then return here.
            const back = encodeURIComponent(req.originalUrl);
            return res.redirect(`/mcp-consent?return=${back}`);
        }

        req.session.mcpPending = {
            id: sessionStore.randomToken(),
            userId: admin.id,
            clientId: client.client_id,
            clientName: client.client_name || null,
            redirectUri: params.redirectUri,
            codeChallenge: params.codeChallenge || null,
            state: params.state || null,
            scopes: params.scopes && params.scopes.length ? params.scopes : ['mcp'],
            createdAt: Date.now(),
        };
        req.session.save(() => res.redirect('/mcp-consent'));
    },

    async challengeForAuthorizationCode(client, authorizationCode) {
        const row = await getAsync(
            'SELECT code_challenge FROM oauth_auth_codes WHERE code = ? AND client_id = ?',
            [authorizationCode, client.client_id]
        );
        return row ? row.code_challenge : undefined;
    },

    async exchangeAuthorizationCode(client, authorizationCode, codeVerifier, redirectUri) {
        const row = await getAsync('SELECT * FROM oauth_auth_codes WHERE code = ?', [authorizationCode]);
        if (!row || row.client_id !== client.client_id) {
            throw grantError('invalid_grant: unknown authorization code');
        }
        // One-time use.
        await runAsync('DELETE FROM oauth_auth_codes WHERE code = ?', [authorizationCode]);
        if (Date.now() > new Date(row.expires_at).getTime()) {
            throw grantError('invalid_grant: authorization code expired');
        }
        if (redirectUri && redirectUri !== row.redirect_uri) {
            throw grantError('invalid_grant: redirect_uri mismatch');
        }
        if (!(await activeAdmin(row.user_id))) {
            throw grantError('invalid_grant: user is no longer an active administrator');
        }

        const session = await sessionStore.createSession({
            userId: row.user_id, clientId: client.client_id, scope: row.scope || 'mcp',
        });
        return {
            access_token: session.accessToken,
            token_type: 'bearer',
            expires_in: session.expiresIn,
            refresh_token: session.refreshToken,
            scope: session.scope,
        };
    },

    async exchangeRefreshToken(client, refreshToken) {
        const refreshed = await sessionStore.refreshSession(refreshToken, client.client_id);
        if (!refreshed) {
            // Past the absolute 6h cap, revoked, or invalid → force re-authentication.
            throw grantError('invalid_grant: refresh token invalid or session expired');
        }
        return {
            access_token: refreshed.accessToken,
            token_type: 'bearer',
            expires_in: refreshed.expiresIn,
            refresh_token: refreshed.refreshToken,
            scope: refreshed.scope,
        };
    },

    async verifyAccessToken(token) {
        const info = await sessionStore.verifyAccessToken(token);
        if (!info) throw tokenError('invalid_token');
        return info;
    },

    async revokeToken(client, request) {
        await sessionStore.revokeToken(request.token);
    },
};

// ---- consent page (self-contained; reuses POST /api/auth/login) -----------

// view: 'login' | 'not_admin' | 'consent' | 'off' | 'none'
// groups: the System page switches ({ reports, surveys }), for the consent text.
function consentPage({ view, username, returnUrl, pending, groups = {} }) {
    let body;
    if (view === 'off') {
        body = `<p>AI assistants can't connect to this SALT server: an administrator has turned off both
           AI report building and AI survey editing (System page in the SALT web app).</p>`;
    } else if (view === 'consent') {
        const name = pending.clientName || 'An application';
        let host = pending.redirectUri;
        try { host = new URL(pending.redirectUri).host; } catch { /* keep raw */ }
        body = `<p>Signed in as <strong>${escapeHtml(username)}</strong>.</p>
           <p><strong>${escapeHtml(name)}</strong> is asking to use SALT as you: ${
              [groups.reports && 'build reports', groups.surveys && 'edit inactive surveys and lab tests'].filter(Boolean).join(', and ')}.</p>
           ${groups.reports ? `<p>If you allow it, it can read the survey data dictionary and summaries, and create
              and run reports. Reports run R code against the survey data, so the application
              can access individual participant records, though the AI is instructed to avoid
              any access to individual level data. Only allow tools that your study's data
              agreements permit to process this data.</p>` : ''}
           ${groups.surveys ? `<p>It can read every survey and create and change inactive surveys and lab tests.
              It can't change or activate the active survey. Lab test changes reach every facility.</p>` : ''}
           <p>You will be returned to <strong>${escapeHtml(host)}</strong>.</p>
           <div class="row">
             <button class="btn allow" id="allow" type="button">Allow</button>
             <button class="btn deny" id="deny" type="button">Deny</button>
           </div>
           <div id="err" class="err"></div>
           <script>
             async function decide(decision) {
               const r = await fetch('/mcp-consent', {
                 method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin',
                 body: JSON.stringify({ id: ${JSON.stringify(pending.id)}, decision })
               });
               const d = await r.json().catch(() => ({}));
               if (r.ok && d.redirect) { location.href = d.redirect; }
               else { document.getElementById('err').textContent = d.error || 'Request failed. Start the connection again.'; }
             }
             document.getElementById('allow').addEventListener('click', () => decide('allow'));
             document.getElementById('deny').addEventListener('click', () => decide('deny'));
           </script>`;
    } else if (view === 'not_admin') {
        body = `<p>Signed in as <strong>${escapeHtml(username)}</strong>.</p>
           <p>Connecting an AI assistant to SALT requires an active administrator account.</p>`;
    } else if (view === 'login') {
        const next = isLocalAuthorizePath(returnUrl) ? returnUrl : null;
        body = `<p>Sign in to your SALT administrator account to connect.</p>
           <form id="f">
             <input id="u" placeholder="Username" autocomplete="username" />
             <input id="p" type="password" placeholder="Password" autocomplete="current-password" />
             <button class="btn allow" type="submit">Sign in</button>
             <div id="err" class="err"></div>
           </form>
           <script>
             const next = ${JSON.stringify(next).replace(/</g, '\\u003c')};
             document.getElementById('f').addEventListener('submit', async (e) => {
               e.preventDefault();
               const r = await fetch('/api/auth/login', {
                 method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin',
                 body: JSON.stringify({ username: document.getElementById('u').value, password: document.getElementById('p').value })
               });
               if (r.ok) { if (next) { location.href = next; } else { location.reload(); } }
               else { const d = await r.json().catch(()=>({})); document.getElementById('err').textContent = d.error || 'Login failed'; }
             });
           </script>`;
    } else {
        body = `<p>There is no pending connection request. Start the connection again from your AI tool.</p>`;
    }

    return `<!doctype html><html><head><meta charset="utf-8"><title>Connect to SALT</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body{font-family:system-ui,Arial,sans-serif;background:#f5f6f8;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
        .card{background:#fff;max-width:420px;padding:2rem;border-radius:10px;box-shadow:0 2px 16px rgba(0,0,0,.08)}
        h1{font-size:1.2rem;margin:0 0 1rem} p{color:#333;line-height:1.45}
        input{display:block;width:100%;padding:.6rem;margin:.4rem 0;border:1px solid #ccc;border-radius:6px;box-sizing:border-box}
        .btn{display:inline-block;padding:.6rem 1.1rem;border-radius:6px;text-decoration:none;border:0;cursor:pointer;font-size:1rem;margin-top:.5rem}
        .allow{background:#2563eb;color:#fff} .deny{background:#e5e7eb;color:#111;margin-left:.5rem}
        .row{margin-top:1rem} .err{color:#b91c1c;margin-top:.5rem;font-size:.9rem}
      </style></head>
      <body><div class="card"><h1>Connect your AI assistant to SALT</h1>${body}</div></body></html>`;
}

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

// ---- mount ----------------------------------------------------------------

async function mountOAuth(app, { baseUrl }) {
    const { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } =
        await import('@modelcontextprotocol/sdk/server/auth/router.js');
    oauthErrors = await import('@modelcontextprotocol/sdk/server/auth/errors.js');

    const issuerUrl = new URL(baseUrl);
    const resourceServerUrl = new URL(baseUrl.replace(/\/$/, '') + '/mcp');

    // Consent page (MCP-owned; reuses the existing login API for credentials).
    app.get('/mcp-consent', async (req, res) => {
        const returnUrl = req.query.return ? String(req.query.return) : null;
        const userId = req.session && req.session.userId;
        res.set('Content-Type', 'text/html');
        if (!userId) {
            return res.send(consentPage({ view: 'login', returnUrl }));
        }
        const u = await getAsync('SELECT username FROM admin_users WHERE id = ?', [userId]);
        const username = u ? u.username : '';
        const admin = await activeAdmin(userId);
        if (!admin) {
            return res.send(consentPage({ view: 'not_admin', username }));
        }
        const groups = await mcpGroups();
        if (!groups.reports && !groups.surveys) {
            return res.send(consentPage({ view: 'off', username }));
        }
        const pending = req.session.mcpPending;
        if (pending && pending.userId === admin.id && Date.now() - pending.createdAt < PENDING_TTL_MS) {
            return res.send(consentPage({ view: 'consent', username, pending, groups }));
        }
        // Signed in but no pending request (e.g. arrived from the login step).
        if (returnUrl && isLocalAuthorizePath(returnUrl)) return res.redirect(returnUrl);
        return res.send(consentPage({ view: 'none', username }));
    });

    // Explicit decision from the consent page (same-origin fetch). Requires the
    // pending request's random id from this session, so a link or cross-site
    // request cannot approve anything.
    app.post('/mcp-consent', async (req, res) => {
        const pending = req.session && req.session.mcpPending;
        const body = req.body || {};
        if (!pending || typeof body.id !== 'string' || body.id !== pending.id) {
            return res.status(403).json({ error: 'No matching connection request. Start the connection again.' });
        }
        delete req.session.mcpPending; // one decision per request
        if (Date.now() - pending.createdAt >= PENDING_TTL_MS) {
            return res.status(403).json({ error: 'This connection request expired. Start the connection again.' });
        }
        const admin = await activeAdmin(req.session.userId);
        if (!admin || admin.id !== pending.userId) {
            return res.status(403).json({ error: 'An active administrator account is required.' });
        }
        if (body.decision !== 'allow') {
            return res.json({ redirect: redirectWith(pending.redirectUri, { error: 'access_denied', state: pending.state }) });
        }
        const groups = await mcpGroups();
        if (!groups.reports && !groups.surveys) {
            return res.status(403).json({ error: 'AI assistants are turned off on this server (System page).' });
        }
        const code = await issueAuthorizationCode(pending);
        return res.json({ redirect: redirectWith(pending.redirectUri, { code, state: pending.state }) });
    });

    app.use(mcpAuthRouter({
        provider,
        issuerUrl,
        baseUrl: issuerUrl,
        resourceServerUrl,
        scopesSupported: ['mcp'],
        resourceName: 'SALT',
    }));

    console.log(`[mcp] OAuth authorization server mounted (issuer ${issuerUrl.href})`);
    return getOAuthProtectedResourceMetadataUrl(resourceServerUrl);
}

module.exports = { mountOAuth, provider, clientsStore };
