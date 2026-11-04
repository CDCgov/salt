/**
 * Runs the tablet's JEXL library (commons-jexl3 3.3) to parse survey scripts.
 *
 * A long-running Java process (tools/jexl-check) reads one JSON request per
 * line and answers with one JSON line. It starts on first use, is restarted if
 * it dies, and replies are matched to requests by id. Scripts are parsed only,
 * never evaluated.
 *
 * If Java is not installed, parseScripts() resolves to null and callers report
 * "checker unavailable" as a warning instead of failing.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const TOOL_DIR = path.join(__dirname, '..', '..', 'tools', 'jexl-check');
const BUILD_DIR = path.join(TOOL_DIR, 'build');
const LIB_DIR = path.join(TOOL_DIR, 'lib');
const JAVA = process.env.JEXL_CHECK_JAVA || 'java';
const JAVAC = process.env.JEXL_CHECK_JAVAC || 'javac';
const REQUEST_TIMEOUT_MS = 10000;
const RETRY_AFTER_FAILURE_MS = 60000;

let child = null;
let pending = new Map();
let nextId = 1;
let unavailableUntil = 0;
let unavailableReason = null;

function classpath() {
    return [path.join(LIB_DIR, '*'), BUILD_DIR].join(path.delimiter);
}

// The Docker image compiles the helper at build time. In local development,
// compile it on first use if a JDK is available.
function ensureCompiled() {
    if (fs.existsSync(path.join(BUILD_DIR, 'JexlCheck.class'))) return null;
    fs.mkdirSync(BUILD_DIR, { recursive: true });
    const r = spawnSync(JAVAC, ['--release', '11', '-cp', path.join(LIB_DIR, '*'),
        '-d', BUILD_DIR, path.join(TOOL_DIR, 'JexlCheck.java')], { encoding: 'utf8' });
    if (r.error) return `javac not available (${r.error.code || r.error.message})`;
    if (r.status !== 0) return `could not compile the JEXL checker: ${(r.stderr || '').trim()}`;
    return null;
}

function markUnavailable(reason) {
    unavailableReason = reason;
    unavailableUntil = Date.now() + RETRY_AFTER_FAILURE_MS;
    console.warn(`JEXL checker unavailable: ${reason}`);
}

function failPending(message) {
    for (const { reject, timer } of pending.values()) {
        clearTimeout(timer);
        reject(new Error(message));
    }
    pending = new Map();
}

function start() {
    if (child) return child;
    if (Date.now() < unavailableUntil) return null;
    const compileError = ensureCompiled();
    if (compileError) {
        markUnavailable(compileError);
        return null;
    }
    const proc = spawn(JAVA, ['-cp', classpath(), 'JexlCheck'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child = proc;
    proc.on('error', err => {
        if (child === proc) child = null;
        markUnavailable(`java not available (${err.code || err.message})`);
        failPending('JEXL checker failed to start');
    });
    proc.on('exit', code => {
        if (child === proc) child = null;
        failPending(`JEXL checker exited (code ${code})`);
    });
    proc.stderr.on('data', d => console.warn(`[jexl-check] ${String(d).trim()}`));
    proc.stdin.on('error', () => { /* reported through exit/error */ });
    readline.createInterface({ input: proc.stdout }).on('line', line => {
        let msg;
        try { msg = JSON.parse(line); } catch (_) { return; }
        const entry = pending.get(msg.id);
        if (!entry) return;
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) entry.reject(new Error(msg.error));
        else entry.resolve(msg);
    });
    return proc;
}

function request(payload) {
    const proc = start();
    if (!proc) return Promise.resolve(null);
    const id = nextId++;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error('JEXL checker timed out'));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        proc.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
    });
}

/**
 * Parses scripts with the tablet's JEXL library.
 * @param {{key:string, src:string}[]} scripts
 * @returns {Promise<Map<string, {ok:boolean, vars?:string[], calls?:string[], error?:string, line?:number, col?:number}>|null>}
 *          results by key, or null when the checker is unavailable
 */
async function parseScripts(scripts) {
    const results = new Map();
    if (!scripts.length) return results;
    let reply;
    try {
        reply = await request({ scripts });
    } catch (err) {
        console.warn(`JEXL checker request failed: ${err.message}`);
        return null;
    }
    if (!reply) return null;
    for (const r of reply.results || []) results.set(r.key, r);
    return results;
}

/** JEXL version and engine features of the running checker, or null. */
async function checkerInfo() {
    try {
        return await request({ info: true });
    } catch (_) {
        return null;
    }
}

function unavailableMessage() {
    return unavailableReason || 'JEXL checker unavailable';
}

function stop() {
    if (child) {
        const proc = child;
        child = null;
        proc.kill();
    }
    failPending('JEXL checker stopped');
}

module.exports = { parseScripts, checkerInfo, unavailableMessage, stop };
