/**
 * Remove secrets before values are written to the audit log (database and
 * data/audit/*.jsonl). Any object key that looks like a password, password
 * hash, API key, secret or token has its value replaced with "[REDACTED]".
 * Works on objects, arrays, and JSON strings; other values pass through.
 */

const SECRET_KEY = /pass(word)?|pwd|api[_-]?key|secret|token|hash/i;
const REDACTED = '[REDACTED]';

function redactValue(value, depth = 0) {
    if (depth > 10 || value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map(v => redactValue(v, depth + 1));
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = SECRET_KEY.test(k) ? REDACTED : redactValue(v, depth + 1);
        }
        return out;
    }
    return value;
}

/** Redact an object, or a JSON string (returned as a JSON string). */
function redactSecrets(value) {
    if (typeof value === 'string') {
        try {
            return JSON.stringify(redactValue(JSON.parse(value)));
        } catch {
            return value; // not JSON
        }
    }
    return redactValue(value);
}

module.exports = { redactSecrets, SECRET_KEY, REDACTED };
