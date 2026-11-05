/**
 * test-first-login.mjs — an account with a one-time password
 * (admin_users.must_change_password) can do nothing but choose a new
 * password: login sends it to /change-password, pages redirect there, APIs
 * refuse, and the AI assistant connection is not offered. Changing the
 * password checks the old one and the rules, clears the flag and is audited.
 *
 * Writes to the database it runs against, so run it via
 * scripts/run-mcp-tests.sh (throwaway copy) or against a scratch copy.
 * Env: BASE (default http://localhost:3100), SALT_DB_PATH (default
 * data/database/salt.db). Needs the sqlite3 command-line tool.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const bcrypt = require('bcrypt');
const BASE = process.env.BASE || 'http://localhost:3100';
const DB = process.env.SALT_DB_PATH
    || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'database', 'salt.db');
const sql = (q) => execFileSync('sqlite3', [DB, q]).toString().trim();
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) pass++; else { fail++; console.log('FAIL', n, JSON.stringify(d ?? '').slice(0, 400)); } };

// A cookie jar per "browser".
function client() {
    let cookie = '';
    return async (method, p, body, { follow = false } = {}) => {
        const r = await fetch(BASE + p, {
            method, redirect: follow ? 'follow' : 'manual',
            headers: { 'Content-Type': 'application/json', cookie },
            body: body && JSON.stringify(body)
        });
        const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
        const text = await r.text();
        let json = null; try { json = JSON.parse(text); } catch { /* html */ }
        return { status: r.status, location: r.headers.get('location'), json, text };
    };
}

const USER = 'zz_first_login_' + process.pid;
const ONE_TIME = 'abcd-efgh-jkmn-pqrs';
const NEW_PW = 'Zz-new-password-' + Date.now();
execFileSync('sqlite3', [DB, `INSERT OR REPLACE INTO admin_users (username, password_hash, role, is_active, must_change_password)
    VALUES ('${USER}', '${await bcrypt.hash(ONE_TIME, 10)}', 'administrator', 1, 1)`]);
const userId = sql(`SELECT id FROM admin_users WHERE username = '${USER}'`);

const api = client();
let r = await api('POST', '/api/auth/login', { username: USER, password: ONE_TIME });
ok('login with the one-time password works', r.status === 200, r.json);
ok('login sends the account to /change-password', r.json?.redirectUrl === '/change-password', r.json);

r = await api('GET', '/');
ok('pages redirect to /change-password', r.status === 302 && r.location === '/change-password', r);
r = await api('GET', '/surveys');
ok('every page redirects (surveys)', r.status === 302 && r.location === '/change-password', r);
r = await api('GET', '/api/admin/users');
ok('APIs refuse with PASSWORD_CHANGE_REQUIRED', r.status === 403 && r.json?.code === 'PASSWORD_CHANGE_REQUIRED', r.json);
r = await api('GET', '/change-password');
ok('the change-password page opens', r.status === 200 && r.text.includes('one-time password'), r.text.slice(0, 200));
r = await api('GET', '/mcp-consent');
ok('AI assistant consent asks for the password change first', r.status === 200 && r.text.includes('Choose your own password') && !r.text.includes('id="allow"'), r.text.slice(0, 300));

r = await api('POST', '/api/auth/change-password', { current_password: 'wrong-one-time', new_password: NEW_PW });
ok('wrong current password refused', r.status === 400 && /incorrect/.test(r.json?.error), r.json);
r = await api('POST', '/api/auth/change-password', { current_password: ONE_TIME, new_password: 'short' });
ok('short new password refused', r.status === 400 && /at least 12/.test(r.json?.error), r.json);
r = await api('POST', '/api/auth/change-password', { current_password: ONE_TIME, new_password: ONE_TIME });
ok('same password refused', r.status === 400 && /different/.test(r.json?.error), r.json);
ok('flag still set after refusals', sql(`SELECT must_change_password FROM admin_users WHERE id = ${userId}`) === '1');

r = await api('POST', '/api/auth/change-password', { current_password: ONE_TIME, new_password: NEW_PW });
ok('password changed', r.status === 200 && r.json?.redirectUrl === '/', r.json);
ok('flag cleared', sql(`SELECT must_change_password FROM admin_users WHERE id = ${userId}`) === '0');
ok('change is in the audit log', sql(`SELECT COUNT(*) FROM audit_log WHERE user_id = ${userId} AND action = 'change_password'`) === '1');
r = await api('GET', '/');
ok('pages open after the change', r.status === 200, r.status);
r = await api('GET', '/api/admin/users');
ok('APIs work after the change', r.status === 200, r.status);

const fresh = client();
r = await fresh('POST', '/api/auth/login', { username: USER, password: ONE_TIME });
ok('the one-time password no longer works', r.status === 401, r.json);
r = await fresh('POST', '/api/auth/login', { username: USER, password: NEW_PW });
ok('the new password works and goes to the dashboard', r.status === 200 && r.json?.redirectUrl === '/', r.json);

const anon = client();
r = await anon('POST', '/api/auth/change-password', { current_password: 'x', new_password: NEW_PW + 'x' });
ok('change-password needs a session', r.status === 401, r.json);
r = await anon('GET', '/change-password');
ok('change-password page needs a session', r.status === 302 && r.location === '/login', r);

sql(`DELETE FROM admin_users WHERE id = ${userId}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
