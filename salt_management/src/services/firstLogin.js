/**
 * The first administrator's password and the forced change on first login.
 *
 * scripts/init-database.js creates the first administrator with a random
 * password (there is no built-in default), prints it once and saves it to
 * data/initial-admin-password (readable only by the server's user) so
 * install.sh can show it. The account is marked must_change_password, so the
 * first login goes straight to /change-password; the file is deleted once the
 * password is changed.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MIN_PASSWORD_LENGTH = 12;

// No 0/o, 1/l/i: easy to read off a terminal and type.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Random password like "k7wq-3mxr-p9tz-h2nd" (about 79 bits). */
function generateInitialPassword() {
    const groups = [];
    for (let g = 0; g < 4; g++) {
        let s = '';
        for (let i = 0; i < 4; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
        groups.push(s);
    }
    return groups.join('-');
}

/** data/initial-admin-password, next to data/database/. */
function initialPasswordFile(dbPath) {
    return path.join(path.dirname(path.dirname(dbPath)), 'initial-admin-password');
}

function writeInitialPasswordFile(dbPath, username, password) {
    const file = initialPasswordFile(dbPath);
    fs.writeFileSync(file, `username: ${username}\npassword: ${password}\n`, { mode: 0o600 });
    return file;
}

/** Deletes the saved first password once that account has a password of its own. */
function removeInitialPasswordFile(dbPath, username) {
    const file = initialPasswordFile(dbPath);
    try {
        if (fs.readFileSync(file, 'utf8').startsWith(`username: ${username}\n`)) fs.unlinkSync(file);
    } catch (err) {
        if (err.code !== 'ENOENT') console.error('Could not remove the initial password file:', err.message);
    }
}

/** Problem with a proposed new password, or null when it is acceptable. */
function newPasswordProblem(newPassword, currentPassword) {
    if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
        return `The new password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    if (newPassword === currentPassword) return 'The new password must be different from the current one.';
    return null;
}

module.exports = {
    MIN_PASSWORD_LENGTH,
    generateInitialPassword,
    initialPasswordFile,
    writeInitialPasswordFile,
    removeInitialPasswordFile,
    newPasswordProblem
};
