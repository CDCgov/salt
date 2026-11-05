#!/usr/bin/env node
/**
 * drop-option-value.js — remove the unused options.option_value column.
 *
 * Background: option_value was written by the editor, import and seed code but
 * never read. The tablet does not sync it, JEXL compares the 0-based
 * option_index, and exports use the option text. See SALT_IMPROVEMENT_PLAN.md
 * item 5.
 *
 * Data loss: some surveys hold paper-questionnaire codes in this column (e.g.
 * 88 = Don't know). Dropping it deletes them. Export any survey whose codes an
 * analyst may want (Surveys -> Export JSON) before applying.
 *
 * Side effect: the survey checksum changes, so each tablet re-downloads the
 * active survey once at its next login.
 *
 * It is idempotent (does nothing when the column is already gone) and does a
 * dry run unless --yes is passed. Requires SQLite 3.35+ for DROP COLUMN.
 *
 * Usage:
 *   node scripts/drop-option-value.js [--db data/database/salt.db] [--yes]
 *   SALT_DB_PATH=/path/to/salt.db node scripts/drop-option-value.js --yes
 */

const path = require('path');
const sqlite3 = require('sqlite3');

const defaultDb = process.env.SALT_DB_PATH
    || path.join(__dirname, '..', 'data', 'database', 'salt.db');

const args = { db: defaultDb, yes: false };
for (let i = 2; i < process.argv.length; i++) {
    const k = process.argv[i];
    if (k === '--yes') args.yes = true;
    else if (k === '--db') args.db = process.argv[++i];
    else { console.error('Unknown arg:', k); process.exit(1); }
}

const db = new sqlite3.Database(args.db);
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));

(async () => {
    console.log(`Dropping options.option_value on ${args.db} (${args.yes ? 'APPLY' : 'dry run'})\n`);
    const columns = await all('PRAGMA table_info(options)');
    if (!columns.some(c => c.name === 'option_value')) {
        console.log('Column options.option_value not present; nothing to do.');
        db.close();
        return;
    }

    // Report which surveys would lose codes. Editor-made options hold a copy of
    // their own text JSON, which is not a code, so only short values are counted.
    const rows = await all(
        `SELECT s.id, s.name, s.version, COUNT(*) n
           FROM options o
           JOIN questions q ON q.id = o.question_id
           JOIN surveys s ON s.id = q.survey_id
          WHERE o.option_value IS NOT NULL AND o.option_value != ''
            AND o.option_value NOT LIKE '{%'
          GROUP BY s.id ORDER BY s.id`
    );
    const total = (await get('SELECT COUNT(*) n FROM options')).n;
    const coded = rows.reduce((m, r) => m + r.n, 0);
    console.log(`${coded} of ${total} option(s) hold a code that will be deleted.`);
    for (const r of rows) console.log(`  survey ${r.id} "${r.name}" v${r.version}: ${r.n} option(s)`);

    if (!args.yes) {
        console.log('\nExport any of these surveys you want to keep codes for, then re-run with --yes to apply.');
        db.close();
        return;
    }

    await run('ALTER TABLE options DROP COLUMN option_value');
    console.log('\nDropped options.option_value.');
    db.close();
})().catch(err => { console.error('Migration failed:', err); db.close(); process.exit(1); });
