/*
 * Survey editor: checks JEXL scripts as they are typed, and the
 * "Check survey" panel. Needs /js/jexl-check.js and the editor's element ids
 * (eligibilityScript, couponCountScript, questionId, shortName, questionType,
 * sectionId, preScript, validationScript, skipToScript, skipToTarget).
 * The survey id comes from this script tag's data-survey-id.
 */
(function () {
    'use strict';

    var SURVEY_ID = document.currentScript && document.currentScript.dataset.surveyId;
    var byId = function (id) { return document.getElementById(id); };

    function questionPayload(field) {
        var payload = { field: field, survey_id: SURVEY_ID };
        var qid = byId('questionId') && byId('questionId').value;
        if (qid) {
            payload.question_id = Number(qid);
        } else {
            payload.short_name = (byId('shortName') && byId('shortName').value) || undefined;
            payload.question_type = byId('questionType') && byId('questionType').value;
            var section = parseInt(byId('sectionId') && byId('sectionId').value, 10);
            if (!isNaN(section)) payload.section_id = section;
            if (typeof questionsData !== 'undefined') payload.question_index = questionsData.length;
            payload.options = Array.prototype.map.call(
                document.querySelectorAll('.option-wrapper'),
                function (group) {
                    var box = group.querySelector('.option-is-other');
                    return { is_other: box && box.checked ? 1 : 0 };
                });
        }
        if (field === 'skip_to_script') payload.skip_to_target = byId('skipToTarget').value || '';
        return payload;
    }

    function clearModalResults() {
        ['preScript', 'validationScript', 'skipToScript'].forEach(function (id) {
            var el = byId(id);
            if (el) JexlCheck.render(el, null);
        });
    }

    // Re-check the skip-to condition when its target changes.
    function recheckSkipTo() {
        var el = byId('skipToScript');
        if (el && el.value.trim()) el.dispatchEvent(new Event('blur'));
    }

    // ---- "Check survey" panel ----------------------------------------------

    function panel() {
        return byId('surveyCheckResults');
    }

    function issueLine(item) {
        var line = document.createElement('div');
        line.style.color = item.level === 'error' ? '#c0392b' : '#b9770e';
        line.style.margin = '2px 0';
        var prefix = item.level === 'error' ? '✖ ' : '⚠ ';
        if (item.question_id != null && typeof editQuestion === 'function') {
            var link = document.createElement('a');
            link.href = '#';
            link.style.color = 'inherit';
            link.textContent = prefix + item.message;
            link.title = 'Open this question';
            link.addEventListener('click', function (e) {
                e.preventDefault();
                editQuestion(item.question_id);
            });
            line.appendChild(link);
        } else {
            line.textContent = prefix + item.message;
        }
        return line;
    }

    function renderPanel(result) {
        var box = panel();
        if (!box) return;
        box.textContent = '';
        box.style.display = 'block';
        var errors = result.errors || [];
        var warnings = result.warnings || [];
        var head = document.createElement('div');
        head.style.fontWeight = 'bold';
        head.style.marginBottom = '4px';
        if (!errors.length && !warnings.length) {
            head.style.color = '#1e8449';
            head.textContent = result.checked === false
                ? 'The script checker is unavailable.'
                : '✔ No problems found in this survey\'s scripts.';
            box.appendChild(head);
            return;
        }
        head.textContent = errors.length + ' error(s), ' + warnings.length + ' warning(s).'
            + (errors.length ? ' Errors must be fixed before the survey can be activated.' : '');
        box.appendChild(head);
        errors.concat(warnings).forEach(function (item) { box.appendChild(issueLine(item)); });
    }

    function checkSurvey(options) {
        options = options || {};
        var box = panel();
        if (box && !options.quiet) {
            box.style.display = 'block';
            box.textContent = 'Checking…';
        }
        return fetch('/api/admin/survey-config/' + encodeURIComponent(SURVEY_ID) + '/check')
            .then(function (r) { return r.json().then(function (b) { if (!r.ok) throw new Error(b.error || r.status); return b; }); })
            .then(function (result) {
                var hasIssues = (result.errors || []).length || (result.warnings || []).length;
                if (options.quiet && !hasIssues) return result;
                renderPanel(result);
                return result;
            })
            .catch(function (err) {
                if (box) { box.style.display = 'block'; box.textContent = 'Could not check survey: ' + err.message; }
            });
    }

    function init() {
        if (!window.JexlCheck || !SURVEY_ID) return;
        JexlCheck.attach(byId('eligibilityScript'), function () {
            return { field: 'eligibility_script', survey_id: SURVEY_ID };
        }, { showOk: true });
        JexlCheck.attach(byId('couponCountScript'), function () {
            return { field: 'coupon_count_script', survey_id: SURVEY_ID };
        }, { showOk: true });
        ['preScript', 'validationScript', 'skipToScript'].forEach(function (id) {
            var field = { preScript: 'pre_script', validationScript: 'validation_script', skipToScript: 'skip_to_script' }[id];
            JexlCheck.attach(byId(id), function () { return questionPayload(field); });
        });
        var target = byId('skipToTarget');
        if (target) target.addEventListener('blur', recheckSkipTo);

        // Clear old results whenever the question dialog opens.
        ['newQuestion', 'editQuestion'].forEach(function (name) {
            var original = window[name];
            if (typeof original !== 'function') return;
            window[name] = function () {
                clearModalResults();
                return original.apply(this, arguments);
            };
        });

        // Show existing problems when the editor opens.
        checkSurvey({ quiet: true });
    }

    window.SurveyEditorJexl = { checkSurvey: checkSurvey };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
