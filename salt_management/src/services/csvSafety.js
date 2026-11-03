/**
 * Protection against CSV formula injection in files admins download.
 *
 * Spreadsheet programs (Excel, LibreOffice, Google Sheets) treat a cell that
 * starts with = + - @ (or tab / carriage return) as a formula. Participant and
 * tablet text can reach these exports, so a text cell starting with one of
 * those characters gets a leading apostrophe, which makes the spreadsheet show
 * it as plain text.
 *
 * Numbers such as "-3" or "+1.5" are left alone. Apply this ONLY to CSVs that
 * are downloaded, never to the copies given to R reports or MCP clients, so
 * analysis inputs are unchanged.
 */

const FORMULA_START = /^[=+\-@\t\r]/;
const NUMERIC = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

function neutralizeFormula(value) {
    if (value === null || value === undefined) return value;
    const s = String(value);
    if (FORMULA_START.test(s) && !NUMERIC.test(s.trim())) {
        return "'" + s;
    }
    return s;
}

module.exports = { neutralizeFormula };
