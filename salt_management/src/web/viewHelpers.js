/**
 * Output-escaping helpers for EJS views. Registered as app.locals in app.js,
 * so every template can call them.
 *
 * - h(value): escape for HTML text and quoted attribute values. Use it on every
 *   data value placed into HTML (including the `body` template strings that
 *   pages build and the layout prints raw).
 * - jsonForScript(value): JSON for embedding inside a <script> block; escapes
 *   characters that could end the script element or break the parser.
 *
 * Never place data inside inline event handlers (onclick="fn('${x}')"): the
 * browser decodes HTML entities before running the handler, so escaping does
 * not help there. Put the value in a data-* attribute (escaped with h) and read
 * it from the handler (this.dataset.x) instead.
 */

const HTML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '`': '&#96;'
};

function h(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"'`]/g, c => HTML_ESCAPES[c]);
}

function jsonForScript(value) {
    return JSON.stringify(value === undefined ? null : value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

module.exports = { h, jsonForScript };
