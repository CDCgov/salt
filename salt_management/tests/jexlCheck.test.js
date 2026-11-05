/**
 * Tests for the JEXL script checker (src/services/jexlCheck.js and the Java
 * helper in tools/jexl-check). Run with: npm test
 * Needs Java; the parity tests also need the salt_android checkout next to
 * salt_management.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { checkSurveyData, checkLabConditions, _internal } = require('../src/services/jexlCheck');
const { parseScripts, checkerInfo, stop } = require('../src/services/jexlParser');

test.after(() => stop());

const ANDROID = path.join(__dirname, '..', '..', 'salt_android');
const GRADLE = path.join(ANDROID, 'app', 'build.gradle.kts');
const UTIL_KT = path.join(ANDROID, 'app', 'src', 'main', 'java', 'com', 'dev', 'salt', 'Util.kt');

// Features the checker disables beyond the tablet's defaults. When the tablet
// adopts the same JexlFeatures (DRC field fix 5), the tablet's own list must
// match this instead.
const CHECKER_FEATURES = {
    sideEffect: false, sideEffectGlobal: false, loops: false, lambda: false,
    newInstance: false, pragma: false, annotation: false, script: false
};

// ---------------------------------------------------------------------------
// Parity with the tablet

test('checker uses the same JEXL version as the tablet', { skip: !fs.existsSync(GRADLE) && 'salt_android not present' }, async () => {
    const gradle = fs.readFileSync(GRADLE, 'utf8');
    const m = gradle.match(/commons-jexl3:([\d.]+)/);
    assert.ok(m, 'commons-jexl3 dependency not found in build.gradle.kts');
    const info = await checkerInfo();
    assert.ok(info, 'checker did not start (is Java installed?)');
    assert.equal(info.jexlVersion, m[1]);
    const jar = path.join(__dirname, '..', 'tools', 'jexl-check', 'lib', `commons-jexl3-${m[1]}.jar`);
    assert.ok(fs.existsSync(jar), `expected ${jar}`);
});

test('checker engine settings match the tablet', { skip: !fs.existsSync(UTIL_KT) && 'salt_android not present' }, async () => {
    const util = fs.readFileSync(UTIL_KT, 'utf8');
    const builder = util.slice(util.indexOf('JexlBuilder()'), util.indexOf('.create()', util.indexOf('JexlBuilder()')));
    assert.match(builder, /\.strict\(true\)/, 'tablet engine is no longer strict');
    assert.match(builder, /\.silent\(false\)/, 'tablet engine is no longer silent(false)');
    const info = await checkerInfo();
    assert.deepEqual(info.features, CHECKER_FEATURES);
    if (/features\s*\(/.test(builder) || /JexlFeatures\(\)/.test(util)) {
        // Tablet sets its own features: every flag the checker disables must
        // be disabled there too.
        for (const name of Object.keys(CHECKER_FEATURES)) {
            assert.match(util, new RegExp(`\\.${name}\\(false\\)`), `tablet JexlFeatures should set ${name}(false)`);
        }
    }
});

// ---------------------------------------------------------------------------
// Parser: known-good and known-bad scripts (DRC field test cases included)

test('parser rejects bad scripts and lists variables for good ones', async () => {
    const r = await parseScripts([
        { key: 'not_less', src: 'hivlasttest !< 2' },
        { key: 'two_lines', src: 'a == 1\nb == 2' },
        { key: 'assign', src: 'a = 1' },
        { key: 'good', src: 'value <= Networksize_PSE && age1 >= 15' },
        { key: 'contains', src: 'a.contains(1)' },
        { key: 'membership', src: "otherwork_type =~ [1, 6] && x == 'a(b)'" },
        { key: 'loop', src: 'for (var i : [1]) { i }' },
        { key: 'lambda', src: 'x -> x' },
        { key: 'getclass', src: 'a.getClass()' }
    ]);
    assert.ok(r, 'checker unavailable');
    assert.equal(r.get('not_less').ok, false);
    assert.equal(r.get('two_lines').ok, false);
    assert.equal(r.get('assign').ok, false);
    assert.match(r.get('assign').error, /assign/);
    assert.deepEqual(r.get('good').vars, ['value', 'Networksize_PSE', 'age1']);
    assert.deepEqual(r.get('contains').vars, ['a']);
    assert.deepEqual(r.get('contains').calls, ['.contains']);
    assert.deepEqual(r.get('membership').calls, [], 'text inside quotes is not a call');
    assert.equal(r.get('loop').ok, false);
    assert.equal(r.get('lambda').ok, false);
    assert.deepEqual(r.get('getclass').calls, ['.getClass']);
});

// ---------------------------------------------------------------------------
// Survey rules

const EN = (t) => JSON.stringify({ English: t, French: t });
const EN_ONLY = (t) => JSON.stringify({ English: t });

function survey(overrides = {}) {
    const sections = [
        { id: 1, section_type: 'eligibility', section_index: 0 },
        { id: 2, section_type: 'main', section_index: 1 }
    ];
    const questions = [
        { id: 10, question_index: 0, short_name: 'age1', question_type: 'numeric', section_id: 1, question_text_json: EN('Age') },
        { id: 11, question_index: 1, short_name: 'kp', question_type: 'multiple_choice', section_id: 1, question_text_json: EN('Group') },
        { id: 12, question_index: 2, short_name: 'otherwork_type', question_type: 'multi_select', section_id: 2, question_text_json: EN('Work') },
        { id: 13, question_index: 3, short_name: 'Networksize_PSE', question_type: 'numeric', section_id: 2, question_text_json: EN('Network'), pre_script: 'kp != 0' },
        { id: 14, question_index: 4, short_name: 'friends', question_type: 'numeric', section_id: 2, question_text_json: EN('Friends') },
        { id: 15, question_index: 5, short_name: 'hivresult', question_type: 'multiple_choice', section_id: 2, question_text_json: EN('Result') },
        { id: 16, question_index: 6, short_name: 'last', question_type: 'text', section_id: 2, question_text_json: EN('Last') }
    ];
    const opt = (qid, n, extra = {}) => Array.from({ length: n }, (_, i) => ({
        question_id: qid, option_index: i, option_text_json: EN(`opt ${i}`), is_other: 0, ...(extra[i] || {})
    }));
    const options = [
        ...opt(11, 3),
        ...opt(12, 7, { 6: { is_other: 1 } }),
        ...opt(15, 2)
    ];
    const data = {
        survey: { languages: JSON.stringify(['English', 'French']), eligibility_script: 'age1 >= 15 && kp != 2' },
        sections, questions, options, testIds: []
    };
    for (const [shortName, fields] of Object.entries(overrides.questions || {})) {
        Object.assign(data.questions.find(q => q.short_name === shortName), fields);
    }
    Object.assign(data.survey, overrides.survey || {});
    return data;
}

const messages = (res) => [...res.errors, ...res.warnings].map(i => `${i.level}: ${i.message}`);
function expectIssue(res, level, pattern) {
    const list = level === 'error' ? res.errors : res.warnings;
    assert.ok(list.some(i => pattern.test(i.message)),
        `expected ${level} matching ${pattern}, got:\n  ${messages(res).join('\n  ') || '(none)'}`);
}

test('a clean survey has no issues', async () => {
    const res = await checkSurveyData(survey({
        questions: {
            friends: { validation_script: 'value >= 0', skip_to_script: 'value == 0', skip_to_target: 'last' },
            hivresult: { pre_script: '1 =~ otherwork_type || otherwork_type.contains(6) || kp =~ [1, 2]' },
            last: { pre_script: 'otherwork_type_other != null && Networksize_PSE != null && Networksize_PSE > 2' }
        },
        survey: { coupon_count_script: 'kp == 1 ? 0 : facility_coupons' }
    }));
    assert.equal(res.checked, true);
    assert.deepEqual(messages(res), []);
});

test('syntax errors and assignments are errors', async () => {
    const res = await checkSurveyData(survey({
        questions: { friends: { validation_script: 'hivlasttest !< 2' }, last: { pre_script: 'kp = 1' } },
        survey: { eligibility_script: 'age1 >= 15\nkp != 2' }
    }));
    expectIssue(res, 'error', /Validation \(friends\): Syntax error/);
    expectIssue(res, 'error', /Skip logic \(last\): Assignment \(=\) is not allowed/);
    expectIssue(res, 'error', /Eligibility script: Syntax error.*line 2/);
});

test('unknown variable names are errors with a suggestion', async () => {
    const res = await checkSurveyData(survey({ survey: { eligibility_script: 'age >= 15' } }));
    expectIssue(res, 'error', /Unknown variable "age".*Did you mean "age1"/);
});

test('"value" only where it is set; facility_coupons only in the coupon script', async () => {
    const res = await checkSurveyData(survey({
        questions: { friends: { pre_script: 'value > 1' } },
        survey: { eligibility_script: 'facility_coupons > 1' }
    }));
    expectIssue(res, 'error', /Skip logic \(friends\): "value" is only set in validation and skip-to scripts/);
    expectIssue(res, 'error', /Eligibility script: Unknown variable "facility_coupons"/);
});

test('method calls outside the allowed list are errors', async () => {
    const res = await checkSurveyData(survey({ questions: { last: { pre_script: 'kp.getClass() != null' } } }));
    expectIssue(res, 'error', /\.getClass\(\) is not allowed/);
});

test('multi-select compared with == is a warning', async () => {
    const res = await checkSurveyData(survey({ questions: { hivresult: { pre_script: 'otherwork_type == 6' } } }));
    expectIssue(res, 'warning', /"otherwork_type" is a multi-select question.*"6 =~ otherwork_type"/);
});

test('multi-select on the left of =~ with a list is a warning', async () => {
    const res = await checkSurveyData(survey({ questions: { hivresult: { pre_script: 'otherwork_type =~ [1, 2]' } } }));
    expectIssue(res, 'warning', /tests whether every ticked option is in the list/);
});

test('option numbers out of range are warnings', async () => {
    const res = await checkSurveyData(survey({
        questions: { last: { pre_script: 'kp == 9 || 7 =~ otherwork_type || otherwork_type.contains(8) || kp =~ [0, 3]' } }
    }));
    expectIssue(res, 'warning', /"kp" has 3 options, numbered 0 to 2, so 9 never matches/);
    expectIssue(res, 'warning', /"kp" has 3 options, numbered 0 to 2, so 3 never matches/);
    expectIssue(res, 'warning', /"otherwork_type" has 7 options.*so 7 never matches/);
    expectIssue(res, 'warning', /"otherwork_type" has 7 options.*so 8 never matches/);
});

test('questions asked later are warnings', async () => {
    const res = await checkSurveyData(survey({
        questions: { friends: { pre_script: 'hivresult == 1 || friends > 0' } },
        survey: { eligibility_script: 'age1 >= 15 && friends > 2' }
    }));
    expectIssue(res, 'warning', /Skip logic \(friends\): "hivresult" is asked later/);
    expectIssue(res, 'warning', /Skip logic \(friends\): Skip logic uses the question's own answer/);
    expectIssue(res, 'warning', /Eligibility script: "friends" is asked after the eligibility check/);
});

test('relational comparison on a question that may be skipped is a warning', async () => {
    const res = await checkSurveyData(survey({
        questions: {
            friends: { validation_script: 'value <= Networksize_PSE' },
            last: { pre_script: 'friends > 3' },
            hivresult: { skip_to_script: 'hivresult == 0', skip_to_target: 'last' }
        }
    }));
    expectIssue(res, 'warning', /Validation \(friends\): "Networksize_PSE" may have been skipped/);
    // friends is not behind a skip, and hivresult's jump passes no question
    assert.ok(!res.warnings.some(i => /"friends" may have been skipped/.test(i.message)));
});

test('a question behind a skip-to jump may be skipped', async () => {
    const res = await checkSurveyData(survey({
        questions: {
            otherwork_type: { skip_to_script: '0 =~ otherwork_type', skip_to_target: 'hivresult' },
            last: { pre_script: 'friends > 3' }
        }
    }));
    expectIssue(res, 'warning', /Skip logic \(last\): "friends" may have been skipped/);
});

test('"other" text compared with < or > is a warning', async () => {
    const res = await checkSurveyData(survey({ questions: { last: { pre_script: 'otherwork_type_other > 3' } } }));
    expectIssue(res, 'warning', /"otherwork_type_other" is the "other" text/);
});

test('_other names exist only for questions with an other option', async () => {
    const res = await checkSurveyData(survey({ questions: { last: { pre_script: "kp_other == 'x'" } } }));
    expectIssue(res, 'error', /Unknown variable "kp_other"/);
});

test('.contains() on a question that is not multi-select is a warning', async () => {
    const res = await checkSurveyData(survey({ questions: { last: { pre_script: 'kp.contains(1)' } } }));
    expectIssue(res, 'warning', /"kp" is not a multi-select question, so \.contains\(\)/);
});

test('a blank eligibility script is a warning, not an error', async () => {
    for (const blank of [null, '', '   ']) {
        const res = await checkSurveyData(survey({ survey: { eligibility_script: blank } }));
        expectIssue(res, 'warning', /no eligibility script, so every participant is eligible/);
        assert.ok(!res.errors.some(e => e.field === 'eligibility_script'));
    }
});

test('skip-to targets must exist and come later', async () => {
    const res = await checkSurveyData(survey({
        questions: {
            otherwork_type: { skip_to_script: '0 =~ otherwork_type' },
            friends: { skip_to_script: 'value == 0', skip_to_target: 'q19' },
            hivresult: { skip_to_script: 'value == 0', skip_to_target: 'kp' }
        }
    }));
    expectIssue(res, 'error', /Skip-to target \(otherwork_type\): The skip-to condition has no target question/);
    expectIssue(res, 'error', /Skip-to target \(friends\): Target "q19" is not a question/);
    expectIssue(res, 'error', /Skip-to target \(hivresult\): Target "kp" must come after this question/);
});

test('missing translations are warnings', async () => {
    const data = survey();
    data.questions.find(q => q.short_name === 'age1').question_text_json = EN_ONLY('Age');
    data.options.find(o => o.question_id === 11 && o.option_index === 2).option_text_json = EN_ONLY('x');
    const res = await checkSurveyData(data);
    expectIssue(res, 'warning', /Translations \(age1\): question text missing in French/);
    expectIssue(res, 'warning', /Translations \(kp\): option 2 text missing in French/);
});

test('lab test conditions: rapid test ids allowed, option numbers flagged', async () => {
    const data = survey();
    data.testIds = ['hiv_test_1'];
    const res = await checkLabConditions([
        { id: 1, test_name: 'Viral load', jexl_condition: "hiv_test_1 == 'positive'" },
        { id: 2, test_name: 'Syphilis', jexl_condition: 'kp == 1' },
        { id: 3, test_name: 'Other', jexl_condition: 'nosuch == 1' },
        { id: 4, test_name: 'Broken', jexl_condition: 'a !< 1' }
    ], data);
    assert.ok(!messages(res).some(m => /Viral load/.test(m)), messages(res).join('\n'));
    expectIssue(res, 'warning', /Lab test condition \(Syphilis\): .*option's text, not its number/);
    expectIssue(res, 'error', /Lab test condition \(Other\): Unknown variable "nosuch"/);
    expectIssue(res, 'error', /Lab test condition \(Broken\): Syntax error/);
});

test('without Java, checks report the checker as unavailable instead of failing', () => {
    const script = `
        const { checkSurveyData } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'services', 'jexlCheck'))});
        checkSurveyData({ survey: { eligibility_script: 'a == 1' }, sections: [], questions: [], options: [] })
            .then(r => { console.log(JSON.stringify(r)); process.exit(0); });`;
    const out = spawnSync(process.execPath, ['-e', script], {
        encoding: 'utf8',
        env: { ...process.env, JEXL_CHECK_JAVA: '/nonexistent/java' }
    });
    assert.equal(out.status, 0, out.stderr);
    const res = JSON.parse(out.stdout.trim().split('\n').pop());
    assert.equal(res.checked, false);
    assert.equal(res.errors.length, 0);
    assert.match(res.warnings[0].message, /JEXL checker is unavailable/);
});

// ---------------------------------------------------------------------------
// Source scanning helpers

test('string contents are never scanned', () => {
    const { blankStrings, literalComparisons } = _internal;
    assert.equal(blankStrings("a == 'b == 1'"), "a == '      '");
    assert.deepEqual(literalComparisons(blankStrings("x == 'y == 3' && z != 4")).map(c => c.name), ['z']);
    assert.deepEqual(literalComparisons('2 < age1').map(c => [c.name, c.op]), [['age1', '>']]);
});
