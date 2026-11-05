/**
 * Environment for the R and Quarto processes that render reports and build
 * data profiles.
 *
 * Report R code is written by administrators and, when report building is
 * switched on, by AI assistants, so those processes must not inherit the
 * server's secrets (SESSION_SECRET, keys, tokens, MCP settings). Only the
 * variables R and Quarto need are passed through: the search path, home
 * directory (Quarto finds TinyTeX there), temp directory, time zone, locale,
 * and R_* / QUARTO_* / XDG_* settings. Anything whose name looks like a
 * secret is dropped even if it matches.
 *
 * This keeps secrets out of the environment only. The process still runs as
 * the server's user and can read the files that user can.
 */

const PASS_THROUGH = new Set([
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
    'TMPDIR', 'TMP', 'TEMP', 'TZ', 'LANG', 'LANGUAGE'
]);
const PASS_THROUGH_PREFIXES = ['LC_', 'R_', 'QUARTO_', 'XDG_'];
const SECRET_NAME = /SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|CREDENTIAL|PRIVATE/i;

function childProcessEnv(overrides = {}, source = process.env) {
    const env = {};
    for (const [name, value] of Object.entries(source)) {
        if (value === undefined || SECRET_NAME.test(name)) continue;
        if (PASS_THROUGH.has(name) || PASS_THROUGH_PREFIXES.some(p => name.startsWith(p))) {
            env[name] = value;
        }
    }
    return { ...env, ...overrides };
}

module.exports = { childProcessEnv };
