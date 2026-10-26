/**
 * Validation for identifiers that end up in file names, plus a path guard.
 *
 * Tablet-generated IDs are UUIDs (survey and payment IDs) or prefixed UUIDs
 * (log IDs such as "LOG_<uuid>"); participant/subject IDs are short codes.
 * All of them match SAFE_ID. Anything else is rejected before it is used to
 * build a path, which rules out "/", "\", "." and other path or HTML syntax.
 */
const path = require('path');

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function isSafeId(value) {
    return typeof value === 'string' && SAFE_ID.test(value);
}

/**
 * Join a file name onto a directory and refuse the result unless it stays
 * inside that directory. Defence in depth on top of isSafeId.
 */
function safeJoin(dir, fileName) {
    const base = path.resolve(dir);
    const full = path.resolve(base, fileName);
    if (path.dirname(full) !== base) {
        throw new Error('Refusing to write outside ' + base);
    }
    return full;
}

module.exports = { SAFE_ID, isSafeId, safeJoin };
