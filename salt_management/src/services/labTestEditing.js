/**
 * labTestEditing.js — lab test configuration edits shared by the web routes
 * (src/api/routes/labTests.js) and the MCP lab test tools.
 *
 * Lab tests are global: active ones go to every tablet at its next login. A
 * test that already has results (lab_results) keeps its code, type and
 * options, so existing results stay readable; to change those, create a new
 * test and deactivate the old one.
 *
 * Failures throw EditError (status + message), like services/surveyEditing.js.
 * ctx: { userId, via?: 'web'|'mcp' }
 */

const { getAsync, runAsync } = require('../models/database');
const { logAudit } = require('./auditService');
const { EditError } = require('./surveyEditing');
const database = require('../models/database');
const { checkLabConditions, loadSurveyData } = require('./jexlCheck');

const TEST_TYPES = ['dropdown', 'numeric'];
const ALL_FACILITIES_NOTE = 'This lab test is active, so the change reaches every facility\'s tablets at their next login.';

function parseOptions(json) {
    try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

// Options are stored as a JSON array; entries are strings or {label, value}.
function optionKey(o) {
    return typeof o === 'string' ? o : (o && (o.value ?? o.label));
}

function checkFields(fields, { creating }) {
    if (creating || fields.test_name !== undefined) {
        if (typeof fields.test_name !== 'string' || !fields.test_name.trim()) {
            throw new EditError(400, creating ? 'Test name is required' : 'Test name cannot be empty');
        }
    }
    if (fields.test_code !== undefined && fields.test_code !== null && fields.test_code !== '') {
        if (!/^[A-Za-z0-9]+$/.test(String(fields.test_code))) throw new EditError(400, 'Test code must be alphanumeric');
    }
    if (creating || fields.test_type !== undefined) {
        if (!TEST_TYPES.includes(fields.test_type)) throw new EditError(400, 'Test type must be dropdown or numeric');
    }
    if (fields.options !== undefined && fields.options !== null) {
        if (!Array.isArray(fields.options) || fields.options.length < 2) {
            throw new EditError(400, 'Dropdown tests must have at least 2 options');
        }
    }
    for (const k of ['min_value', 'max_value']) {
        if (fields[k] !== undefined && fields[k] !== null && Number.isNaN(Number(fields[k]))) {
            throw new EditError(400, `${k === 'min_value' ? 'Min' : 'Max'} value must be numeric`);
        }
    }
    if (fields.display_order !== undefined && !Number.isInteger(Number(fields.display_order))) {
        throw new EditError(400, 'Display order must be an integer');
    }
}

async function checkUnique(fields, excludeId) {
    if (fields.test_name !== undefined) {
        const dup = await getAsync('SELECT id FROM lab_test_configurations WHERE test_name = ? AND id != ?', [fields.test_name, excludeId || 0]);
        if (dup) throw new EditError(409, 'Test name already exists');
    }
    if (fields.test_code) {
        const dup = await getAsync('SELECT id FROM lab_test_configurations WHERE test_code = ? AND id != ?', [fields.test_code, excludeId || 0]);
        if (dup) throw new EditError(409, 'Test code already exists');
    }
}

function audit(ctx, action, id, oldValue, newValue) {
    const withVia = ctx.via ? { ...(newValue || {}), via: ctx.via } : newValue;
    return logAudit(ctx.userId || null, action, 'lab_test', String(id), oldValue, withVia)
        .catch(err => console.error('Audit write failed:', err));
}

async function createLabTest(fields, ctx = {}) {
    checkFields(fields, { creating: true });
    if (fields.test_type === 'dropdown' && (!Array.isArray(fields.options) || fields.options.length < 2)) {
        throw new EditError(400, 'Dropdown tests must have at least 2 options');
    }
    if (fields.test_type === 'numeric' && fields.min_value != null && fields.max_value != null
        && !(parseFloat(fields.max_value) > parseFloat(fields.min_value))) {
        throw new EditError(400, 'Max value must be greater than min value');
    }
    await checkUnique(fields, null);

    const numeric = fields.test_type === 'numeric';
    const result = await runAsync(
        `INSERT INTO lab_test_configurations
        (test_name, test_code, test_type, options, min_value, max_value, unit, description, display_order, jexl_condition)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            fields.test_name,
            fields.test_code || null,
            fields.test_type,
            fields.test_type === 'dropdown' ? JSON.stringify(fields.options) : null,
            numeric && fields.min_value != null ? parseFloat(fields.min_value) : null,
            numeric && fields.max_value != null ? parseFloat(fields.max_value) : null,
            numeric ? (fields.unit || null) : null,
            fields.description || null,
            fields.display_order || 0,
            fields.jexl_condition || null
        ]
    );
    await audit(ctx, 'CREATE_LAB_TEST', result.id, null, { ...fields });
    return { id: result.id, notes: [ALL_FACILITIES_NOTE] };
}

/**
 * Updates the given fields. With protectResults (MCP), a test with results
 * refuses changes to test_code and test_type and refuses removing options.
 */
async function updateLabTest(testId, fields, ctx = {}, { protectResults = false } = {}) {
    const existing = await getAsync('SELECT * FROM lab_test_configurations WHERE id = ?', [testId]);
    if (!existing) throw new EditError(404, 'Lab test not found');
    checkFields(fields, { creating: false });
    await checkUnique(fields, testId);

    if (protectResults) {
        const { n } = await getAsync('SELECT COUNT(*) n FROM lab_results WHERE test_id = ?', [testId]);
        if (n > 0) {
            const blocked = [];
            if (fields.test_code !== undefined && (fields.test_code || null) !== (existing.test_code || null)) blocked.push('test_code');
            if (fields.test_type !== undefined && fields.test_type !== existing.test_type) blocked.push('test_type');
            if (fields.options !== undefined) {
                const kept = new Set((fields.options || []).map(optionKey));
                const removed = parseOptions(existing.options).map(optionKey).filter(k => !kept.has(k));
                if (removed.length) blocked.push(`options (would remove ${removed.map(r => JSON.stringify(r)).join(', ')})`);
            }
            if (blocked.length) {
                throw new EditError(409,
                    `"${existing.test_name}" already has ${n} result(s), so ${blocked.join(' and ')} can't change: existing results would become unreadable. ` +
                    'Create a new lab test and deactivate this one instead. The name, unit, description, display order, range and JEXL condition can still be edited.');
            }
        }
    }

    const columns = {
        test_name: v => v, test_code: v => v || null, test_type: v => v,
        options: v => (v === null ? null : JSON.stringify(v)),
        min_value: v => (v === null ? null : parseFloat(v)), max_value: v => (v === null ? null : parseFloat(v)),
        unit: v => v, description: v => v, display_order: v => v,
        is_active: v => (v ? 1 : 0), jexl_condition: v => v || null
    };
    const updateFields = [];
    const params = [];
    for (const [col, conv] of Object.entries(columns)) {
        if (fields[col] === undefined) continue;
        updateFields.push(`${col} = ?`);
        params.push(conv(fields[col]));
    }
    if (updateFields.length === 0) throw new EditError(400, 'No valid updates provided');
    params.push(testId);
    await runAsync(`UPDATE lab_test_configurations SET ${updateFields.join(', ')} WHERE id = ?`, params);

    const after = await getAsync('SELECT * FROM lab_test_configurations WHERE id = ?', [testId]);
    await audit(ctx, 'UPDATE_LAB_TEST', testId, existing, { ...fields });
    const notes = [];
    if (after.is_active) notes.push(ALL_FACILITIES_NOTE);
    return { id: testId, is_active: !!after.is_active, notes };
}

async function setLabTestActive(testId, active, ctx = {}) {
    const existing = await getAsync('SELECT * FROM lab_test_configurations WHERE id = ?', [testId]);
    if (!existing) throw new EditError(404, 'Lab test not found');
    await runAsync('UPDATE lab_test_configurations SET is_active = ? WHERE id = ?', [active ? 1 : 0, testId]);
    await audit(ctx, active ? 'REACTIVATE_LAB_TEST' : 'DEACTIVATE_LAB_TEST', testId,
        { is_active: existing.is_active }, { is_active: active ? 1 : 0 });
    return {
        id: testId,
        is_active: active,
        notes: [active
            ? ALL_FACILITIES_NOTE
            : 'Deactivated: tablets stop offering this test at their next login. Existing results are kept.']
    };
}

// Checks a lab test's JEXL condition against the active survey. Saves are
// never blocked; the result is returned with the save response.
async function labConditionReport(testId) {
    try {
        const lab = await getAsync('SELECT id, test_name, jexl_condition FROM lab_test_configurations WHERE id = ?', [testId]);
        if (!lab || !lab.jexl_condition) return { errors: [], warnings: [], checked: true };
        const active = await getAsync('SELECT id FROM surveys WHERE is_active = 1 ORDER BY id DESC LIMIT 1');
        const data = active ? await loadSurveyData(database, active.id) : null;
        return await checkLabConditions([lab], data);
    } catch (err) {
        console.error('Lab condition check failed:', err);
        return null;
    }
}

module.exports = { labConditionReport, createLabTest, updateLabTest, setLabTestActive, TEST_TYPES };
