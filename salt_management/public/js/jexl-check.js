/*
 * Browser helpers for the JEXL script checker (POST /api/jexl/check).
 * Used by the survey editor and the lab test form. Messages are inserted as
 * text, never HTML.
 */
(function (global) {
    'use strict';

    function check(payload) {
        return fetch('/api/jexl/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(function (r) {
            return r.json().then(function (body) {
                if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
                return body;
            });
        });
    }

    function stripLabel(message) {
        // "Validation (age1): Unknown variable…" -> "Unknown variable…"
        var i = message.indexOf(': ');
        return i > 0 && i < 60 ? message.slice(i + 2) : message;
    }

    /**
     * Shows a check result under a field. `container` is an element (created
     * on demand after `field` when omitted). Returns the container.
     */
    function render(field, result, options) {
        options = options || {};
        var box = options.container || field.nextElementSibling;
        if (!box || !box.classList || !box.classList.contains('jexl-check-result')) {
            box = document.createElement('div');
            box.className = 'jexl-check-result';
            box.style.marginTop = '4px';
            box.style.fontSize = '0.85em';
            field.insertAdjacentElement('afterend', box);
        }
        box.textContent = '';
        field.style.borderColor = '';
        if (!result) return box;
        var items = [];
        (result.errors || []).forEach(function (i) { items.push({ level: 'error', text: i.message }); });
        (result.warnings || []).forEach(function (i) { items.push({ level: 'warning', text: i.message }); });
        items.forEach(function (item) {
            var line = document.createElement('div');
            line.style.color = item.level === 'error' ? '#c0392b' : '#b9770e';
            line.textContent = (item.level === 'error' ? '✖ ' : '⚠ ')
                + (options.fullMessages ? item.text : stripLabel(item.text));
            box.appendChild(line);
        });
        if ((result.errors || []).length) field.style.borderColor = '#c0392b';
        else if ((result.warnings || []).length) field.style.borderColor = '#e6a700';
        if (options.showOk && !items.length && result.checked !== false) {
            var ok = document.createElement('div');
            ok.style.color = '#1e8449';
            ok.textContent = '✔ No problems found';
            box.appendChild(ok);
        }
        return box;
    }

    /** Plain-text summary for alert() dialogs. */
    function summary(result, max) {
        if (!result) return '';
        max = max || 10;
        var lines = [];
        [['errors', 'Script errors'], ['warnings', 'Script warnings']].forEach(function (pair) {
            var list = result[pair[0]] || [];
            if (!list.length) return;
            if (lines.length) lines.push('');
            lines.push(pair[1] + ' (' + list.length + '):');
            list.slice(0, max).forEach(function (i) { lines.push('• ' + i.message); });
            if (list.length > max) lines.push('… and ' + (list.length - max) + ' more.');
        });
        return lines.join('\n');
    }

    /**
     * Checks `field` when it loses focus. `payloadFn` returns the request body
     * (without src), or null to skip.
     */
    function attach(field, payloadFn, options) {
        if (!field || field.dataset.jexlCheckAttached) return;
        field.dataset.jexlCheckAttached = '1';
        field.addEventListener('blur', function () {
            var src = field.value || '';
            if (!src.trim()) { render(field, null, options); return; }
            var payload = payloadFn();
            if (!payload) return;
            payload.src = src;
            check(payload).then(function (result) {
                render(field, result, options);
            }).catch(function (err) {
                render(field, { errors: [], warnings: [{ message: 'Could not check script: ' + err.message }] }, options);
            });
        });
    }

    global.JexlCheck = { check: check, render: render, summary: summary, attach: attach };
})(window);
