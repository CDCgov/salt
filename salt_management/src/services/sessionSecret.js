/**
 * The secret that signs session cookies.
 *
 * Uses SESSION_SECRET when it is set. Otherwise generates a random 32-byte
 * secret on first start and keeps it in data/.session-secret (readable only
 * by the server's user), so sessions survive restarts. This is the same file
 * the Docker entrypoint creates, so Docker and non-Docker installs behave the
 * same. There is no built-in default: a known secret would let anyone forge
 * a login.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRET_FILE = path.join(__dirname, '..', '..', 'data', '.session-secret');

function getSessionSecret(secretFile = SECRET_FILE) {
    const fromEnv = (process.env.SESSION_SECRET || '').trim();
    if (fromEnv) return fromEnv;

    try {
        const saved = fs.readFileSync(secretFile, 'utf8').trim();
        if (saved) return saved;
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }

    const secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(secretFile), { recursive: true });
    // 'wx' fails if another process created the file first; use theirs then.
    try {
        fs.writeFileSync(secretFile, secret + '\n', { mode: 0o600, flag: 'wx' });
        console.log(`SESSION_SECRET not set; generated one and saved it to ${secretFile}`);
        return secret;
    } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        return fs.readFileSync(secretFile, 'utf8').trim();
    }
}

module.exports = { getSessionSecret, SECRET_FILE };
