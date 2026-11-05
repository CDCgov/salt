#!/usr/bin/env node
/**
 * Reports JEXL script problems in every survey in the database, and in the
 * lab test conditions (checked against the active survey).
 *
 * Usage:
 *   node scripts/check-survey-logic.js            # all surveys
 *   node scripts/check-survey-logic.js 42 43      # only these survey ids
 *   node scripts/check-survey-logic.js --errors   # hide warnings
 *
 * Exit code: 1 if any errors were found, 0 otherwise. Read-only.
 */

const database = require('../src/models/database');
const { checkSurvey, checkLabConditions, loadSurveyData } = require('../src/services/jexlCheck');
const { stop } = require('../src/services/jexlParser');

async function main() {
    const args = process.argv.slice(2);
    const errorsOnly = args.includes('--errors');
    const ids = args.filter(a => /^\d+$/.test(a)).map(Number);

    const surveys = ids.length
        ? await database.allAsync(`SELECT id, name, version, is_active FROM surveys WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, ids)
        : await database.allAsync('SELECT id, name, version, is_active FROM surveys ORDER BY id');

    let totalErrors = 0;
    let unchecked = false;
    const print = (issues) => {
        for (const i of issues) console.log(`  ${i.level === 'error' ? 'ERROR  ' : 'warning'}  ${i.message}`);
    };

    for (const s of surveys) {
        const r = await checkSurvey(database, s.id);
        if (!r.checked) unchecked = true;
        totalErrors += r.errors.length;
        console.log(`\nSurvey ${s.id} "${s.name}" v${s.version}${s.is_active ? ' (active)' : ''}: `
            + `${r.errors.length} error(s), ${r.warnings.length} warning(s)`);
        print(r.errors);
        if (!errorsOnly) print(r.warnings);
    }

    if (!ids.length) {
        const labs = await database.allAsync(
            "SELECT id, test_name, jexl_condition FROM lab_test_configurations WHERE is_active = 1 AND jexl_condition IS NOT NULL AND TRIM(jexl_condition) != ''");
        if (labs.length) {
            const active = await database.getAsync('SELECT id FROM surveys WHERE is_active = 1 ORDER BY id DESC LIMIT 1');
            const r = await checkLabConditions(labs, active ? await loadSurveyData(database, active.id) : null);
            totalErrors += r.errors.length;
            console.log(`\nLab test conditions (${labs.length}): ${r.errors.length} error(s), ${r.warnings.length} warning(s)`);
            print(r.errors);
            if (!errorsOnly) print(r.warnings);
        }
    }

    if (unchecked) console.log('\nThe JEXL checker was unavailable, so scripts were not parsed. Is Java installed?');
    return totalErrors;
}

main()
    .then(errors => { stop(); process.exit(errors ? 1 : 0); })
    .catch(err => { console.error(err); stop(); process.exit(2); });
