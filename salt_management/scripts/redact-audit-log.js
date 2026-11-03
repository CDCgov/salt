#!/usr/bin/env node
/**
 * One-off cleanup: redact passwords, API keys and other secrets from audit
 * entries written before the server started redacting them (see
 * src/services/redact.js). Covers the audit_log table and the
 * data/audit/<yyyy-mm>/*.jsonl files. Safe to run more than once.
 *
 * Usage (from salt_management/):
 *   node scripts/redact-audit-log.js            # report what would change
 *   node scripts/redact-audit-log.js --apply    # make the changes
 *
 * Docker:
 *   docker exec salt-management node scripts/redact-audit-log.js --apply
 *
 * Back up the data directory first.
 */
const fs = require('fs');
const path = require('path');
const { allAsync, runAsync } = require('../src/models/database');
const { redactSecrets } = require('../src/services/redact');

const APPLY = process.argv.includes('--apply');
const AUDIT_DIR = path.join(__dirname, '..', 'data', 'audit');

async function redactTable() {
    const rows = await allAsync('SELECT id, old_value, new_value FROM audit_log');
    let changed = 0;
    for (const row of rows) {
        const oldV = row.old_value == null ? null : redactSecrets(row.old_value);
        const newV = row.new_value == null ? null : redactSecrets(row.new_value);
        if (oldV !== row.old_value || newV !== row.new_value) {
            changed++;
            if (APPLY) {
                await runAsync('UPDATE audit_log SET old_value = ?, new_value = ? WHERE id = ?',
                    [oldV, newV, row.id]);
            }
        }
    }
    return { scanned: rows.length, changed };
}

function redactFiles() {
    let files = 0, lines = 0;
    if (!fs.existsSync(AUDIT_DIR)) return { files, lines };
    for (const month of fs.readdirSync(AUDIT_DIR)) {
        const dir = path.join(AUDIT_DIR, month);
        if (!fs.statSync(dir).isDirectory()) continue;
        for (const name of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
            const file = path.join(dir, name);
            const original = fs.readFileSync(file, 'utf8').split('\n');
            let fileChanged = false;
            const updated = original.map(line => {
                if (!line.trim()) return line;
                const out = redactSecrets(line);
                if (out !== line) { lines++; fileChanged = true; }
                return out;
            });
            if (fileChanged) {
                files++;
                if (APPLY) fs.writeFileSync(file, updated.join('\n'));
            }
        }
    }
    return { files, lines };
}

(async () => {
    const table = await redactTable();
    const files = redactFiles();
    const verb = APPLY ? 'Redacted' : 'Would redact';
    console.log(`${verb} ${table.changed} of ${table.scanned} audit_log rows.`);
    console.log(`${verb} ${files.lines} lines in ${files.files} audit files.`);
    if (!APPLY) console.log('Run with --apply to make these changes.');
    process.exit(0);
})().catch(err => {
    console.error(err);
    process.exit(1);
});
