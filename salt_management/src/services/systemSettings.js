/**
 * systemSettings.js — server-wide settings changed at runtime from the
 * System page (/admin/system), stored in the system_settings table.
 *
 * Reads are cached for a few seconds and the cache is cleared on every write,
 * so MCP requests don't query the database on every call and a change made on
 * the System page applies to the next request.
 *
 * The table is created on first use (and by scripts/init-database.js), so a
 * server that hasn't re-run the database init still works, on the defaults.
 */

const { getAsync, allAsync, runAsync } = require('../models/database');
const { logAudit } = require('./auditService');

const SETTINGS = {
    mcp_reports_enabled: {
        type: 'boolean',
        default: false,
        label: 'AI report building (MCP)',
        description: 'Lets a connected AI assistant read the data dictionary and aggregate summaries, and create and render reports.'
    },
    mcp_survey_editing_enabled: {
        type: 'boolean',
        default: true,
        label: 'AI survey and lab test editing (MCP)',
        description: 'Lets a connected AI assistant create and edit inactive surveys and lab tests. It can never edit or activate the active survey.'
    }
};

const CACHE_MS = 5000;
let cache = null; // { at, values }
let tableReady = null;

function ensureTable() {
    if (!tableReady) {
        tableReady = runAsync(`CREATE TABLE IF NOT EXISTS system_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_by INTEGER,
            updated_at TEXT
        )`).catch(err => { tableReady = null; throw err; });
    }
    return tableReady;
}

function parse(def, raw) {
    if (raw === undefined || raw === null) return def.default;
    if (def.type === 'boolean') return raw === 'true' || raw === '1';
    return raw;
}

/** All settings as { key: value }, with defaults for keys never set. */
async function getAll() {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.values;
    await ensureTable();
    const rows = await allAsync('SELECT key, value FROM system_settings');
    const stored = Object.fromEntries(rows.map(r => [r.key, r.value]));
    const values = {};
    for (const [key, def] of Object.entries(SETTINGS)) values[key] = parse(def, stored[key]);
    cache = { at: Date.now(), values };
    return values;
}

async function get(key) {
    if (!SETTINGS[key]) throw new Error(`Unknown setting "${key}"`);
    return (await getAll())[key];
}

/** Settings with their definitions, for the System page. */
async function describe() {
    const values = await getAll();
    await ensureTable();
    const rows = await allAsync(
        `SELECT s.key, s.updated_at, u.username FROM system_settings s
         LEFT JOIN admin_users u ON u.id = s.updated_by`
    );
    const meta = Object.fromEntries(rows.map(r => [r.key, r]));
    return Object.entries(SETTINGS).map(([key, def]) => ({
        key, ...def, value: values[key],
        updated_at: meta[key] ? meta[key].updated_at : null,
        updated_by: meta[key] ? meta[key].username : null
    }));
}

/** Sets a setting and audits the change. Returns { key, old, value }. */
async function set(key, value, userId) {
    const def = SETTINGS[key];
    if (!def) throw Object.assign(new Error(`Unknown setting "${key}"`), { status: 400 });
    if (def.type === 'boolean' && typeof value !== 'boolean') {
        throw Object.assign(new Error(`${key} must be true or false`), { status: 400 });
    }
    const old = await get(key);
    await ensureTable();
    await runAsync(
        `INSERT INTO system_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        [key, String(value), userId || null]
    );
    cache = null;
    await logAudit(userId || null, 'UPDATE_SYSTEM_SETTING', 'system_setting', key, { value: old }, { value })
        .catch(err => console.error('Audit write failed:', err));
    return { key, old, value };
}

/** Which MCP tool groups are on. */
async function mcpGroups() {
    const v = await getAll();
    return { reports: v.mcp_reports_enabled, surveys: v.mcp_survey_editing_enabled };
}

function clearCache() { cache = null; }

module.exports = { SETTINGS, get, getAll, describe, set, mcpGroups, clearCache, ensureTable };
