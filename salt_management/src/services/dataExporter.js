const { neutralizeFormula } = require('./csvSafety');
const { allAsync } = require('../models/database');

class DataExporter {
    /**
     * @param {{forSpreadsheet?: boolean}} options  forSpreadsheet: neutralize
     *   formula-like text cells (see csvSafety.js). Set only for admin downloads;
     *   report inputs must stay unchanged.
     */
    constructor({ forSpreadsheet = false } = {}) {
        this.forSpreadsheet = forSpreadsheet;
    }

    /**
     * Load { short_name -> [option_index, ...] } for every multi_select
     * question, so multi-select answers can be exploded into one column per
     * option. UNIONs option indices across all questions sharing a short_name
     * (defensive — covers schemas where the same short_name appears under
     * more than one survey version).
     */
    async loadMultiSelectMeta() {
        const rows = await allAsync(`
            SELECT q.short_name, o.option_index
            FROM questions q
            JOIN options o ON o.question_id = q.id
            WHERE q.question_type = 'multi_select'
              AND q.short_name IS NOT NULL
              AND o.option_index IS NOT NULL
            GROUP BY q.short_name, o.option_index
            ORDER BY q.short_name, o.option_index
        `);
        const meta = {};
        for (const r of rows) {
            (meta[r.short_name] = meta[r.short_name] || []).push(r.option_index);
        }
        return meta;
    }

    /**
     * Expand multi_select rows into one row per option.
     *
     *   Input row : { variable: 'q_risk', numeric_value: null,
     *                 text_value: '0,2', ... }
     *   Output    : N rows, variable = 'q_risk_<i>', numeric_value = 1 if i is
     *                 in the selected set, else 0.
     *
     * Rows for non-multi-select variables pass through unchanged. Rows for
     * multi-select questions that aren't in the meta map (e.g. all options
     * deleted) are dropped, since we can't decide what indicator columns to
     * emit. Indices in text_value that aren't in the current options map are
     * ignored — see plan note on schema drift.
     */
    expandMultiSelectRows(rows, meta) {
        const out = [];
        for (const row of rows) {
            if (typeof row.variable !== 'string' || !row.variable.startsWith('q_')) {
                out.push(row);
                continue;
            }
            const shortName = row.variable.slice(2); // strip 'q_'
            const options = meta[shortName];
            if (!options) {
                out.push(row);
                continue;
            }
            const raw = typeof row.text_value === 'string' ? row.text_value.trim() : '';
            // Empty / null response_multi_indices means the response was cleared
            // (or never had a value). Emit no rows so the cells stay blank in
            // wide format and the question is absent from long format — matches
            // the unanswered-question semantics used elsewhere.
            if (raw === '') continue;
            const selected = new Set(
                raw.split(',')
                    .map(s => parseInt(s.trim(), 10))
                    .filter(n => Number.isInteger(n))
            );
            for (const idx of options) {
                out.push({
                    survey_id: row.survey_id,
                    participant_id: row.participant_id,
                    variable: `q_${shortName}_${idx}`,
                    numeric_value: selected.has(idx) ? 1 : 0,
                    text_value: null
                });
            }
        }
        return out;
    }

    /**
     * Export data in long format
     * @returns {Promise<string>} CSV string
     */
    async exportLongFormat() {
        // Use the exact same query structure as the API export endpoint
        // Exclude soft-deleted subjects (per Feature 4). Only the analytic
        // exports honor the flag — operational tables (uploads, audit) stay
        // unfiltered.
        const whereClause = 'cs.deleted_at IS NULL';
        const params = [];

        const query = `
            -- Metadata fields
            SELECT
                cs.survey_response_id as survey_id,
                cs.participant_id,
                'meta_survey_id' as variable,
                NULL as numeric_value,
                cs.survey_response_id as text_value
            FROM completed_surveys cs
            WHERE ${whereClause}

            UNION ALL

            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'meta_participant_id' as variable,
                NULL,
                cs.participant_id
            FROM completed_surveys cs
            WHERE ${whereClause}

            UNION ALL

            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'meta_facility_id' as variable,
                cs.facility_id,
                NULL
            FROM completed_surveys cs
            WHERE ${whereClause}

            UNION ALL

            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'meta_facility_name' as variable,
                NULL,
                f.name
            FROM completed_surveys cs
            JOIN facilities f ON cs.facility_id = f.id
            WHERE ${whereClause}

            UNION ALL

            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'meta_started_at' as variable,
                NULL,
                cs.started_at
            FROM completed_surveys cs
            WHERE ${whereClause}

            UNION ALL

            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'meta_completed_at' as variable,
                NULL,
                cs.completed_at
            FROM completed_surveys cs
            WHERE ${whereClause}

            UNION ALL

            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'meta_language' as variable,
                NULL,
                cs.language
            FROM completed_surveys cs
            WHERE ${whereClause}

            UNION ALL

            -- Device information
            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'device_id' as variable,
                NULL,
                cs.device_id
            FROM completed_surveys cs
            WHERE ${whereClause} AND cs.device_id IS NOT NULL

            UNION ALL

            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'device_model' as variable,
                NULL,
                cs.device_model
            FROM completed_surveys cs
            WHERE ${whereClause} AND cs.device_model IS NOT NULL

            UNION ALL

            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'device_android_version' as variable,
                NULL,
                cs.android_version
            FROM completed_surveys cs
            WHERE ${whereClause} AND cs.android_version IS NOT NULL

            UNION ALL

            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'device_app_version' as variable,
                NULL,
                cs.app_version
            FROM completed_surveys cs
            WHERE ${whereClause} AND cs.app_version IS NOT NULL

            UNION ALL

            -- Coupon information
            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'coupon_referral_used' as variable,
                NULL,
                cs.referral_coupon_code
            FROM completed_surveys cs
            WHERE ${whereClause} AND cs.referral_coupon_code IS NOT NULL

            UNION ALL

            -- Survey question responses
            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'q_' || sr.question_short_name as variable,
                CASE
                    WHEN sr.answer_type = 'multiple_choice' THEN sr.response_option_index
                    WHEN sr.answer_type = 'numeric' THEN CAST(sr.response_value AS REAL)
                    ELSE NULL
                END as numeric_value,
                CASE
                    WHEN sr.answer_type = 'multiple_choice' THEN sr.response_option_text
                    WHEN sr.answer_type = 'multi_select' THEN sr.response_multi_indices
                    ELSE sr.response_value
                END as text_value
            FROM completed_surveys cs
            JOIN survey_responses sr ON cs.id = sr.completed_survey_id
            WHERE ${whereClause} AND sr.question_short_name IS NOT NULL

            UNION ALL

            -- "Other, specify" free text, as q_<short_name>_other
            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'q_' || sr.question_short_name || '_other' as variable,
                NULL as numeric_value,
                sr.response_other_text as text_value
            FROM completed_surveys cs
            JOIN survey_responses sr ON cs.id = sr.completed_survey_id
            WHERE ${whereClause} AND sr.question_short_name IS NOT NULL
              AND sr.response_other_text IS NOT NULL

            UNION ALL

            -- Rapid test results
            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'rapid_' || rt.test_id || '_result' as variable,
                NULL,
                rt.result
            FROM completed_surveys cs
            JOIN rapid_test_results rt ON cs.id = rt.completed_survey_id
            WHERE ${whereClause}

            UNION ALL

            -- Lab results
            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'lab_' || REPLACE(LOWER(ltc.test_name), ' ', '_') as variable,
                lr.result_numeric,
                lr.result_value
            FROM completed_surveys cs
            JOIN lab_results lr ON cs.participant_id = lr.subject_id
            JOIN lab_test_configurations ltc ON lr.test_id = ltc.id
            WHERE ${whereClause}

            UNION ALL

            -- Payment information
            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'pay_confirmed' as variable,
                CASE WHEN sp.payment_confirmed = 1 THEN 1 ELSE 0 END,
                NULL
            FROM completed_surveys cs
            LEFT JOIN survey_payments sp ON cs.id = sp.completed_survey_id
            WHERE ${whereClause}

            UNION ALL

            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'pay_amount' as variable,
                sp.payment_amount,
                NULL
            FROM completed_surveys cs
            JOIN survey_payments sp ON cs.id = sp.completed_survey_id
            WHERE ${whereClause} AND sp.payment_amount IS NOT NULL

            UNION ALL

            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'pay_type' as variable,
                NULL,
                sp.payment_type
            FROM completed_surveys cs
            JOIN survey_payments sp ON cs.id = sp.completed_survey_id
            WHERE ${whereClause} AND sp.payment_type IS NOT NULL

            UNION ALL

            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'pay_date' as variable,
                NULL,
                sp.payment_date
            FROM completed_surveys cs
            JOIN survey_payments sp ON cs.id = sp.completed_survey_id
            WHERE ${whereClause} AND sp.payment_date IS NOT NULL

            UNION ALL

            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'sample_collected' as variable,
                CASE WHEN sp.sample_collected = 1 THEN 1 ELSE 0 END,
                NULL
            FROM completed_surveys cs
            LEFT JOIN survey_payments sp ON cs.id = sp.completed_survey_id
            WHERE ${whereClause}

            ORDER BY survey_id, variable
        `;

        const rawRows = await allAsync(query, params);
        const multiSelectMeta = await this.loadMultiSelectMeta();
        const rows = this.expandMultiSelectRows(rawRows, multiSelectMeta);

        // Process issued coupons (from JSON) - same as API export
        const surveysWithCoupons = await allAsync(`
            SELECT survey_response_id, participant_id, issued_coupons
            FROM completed_surveys cs
            WHERE ${whereClause} AND issued_coupons IS NOT NULL
        `, params);

        for (const survey of surveysWithCoupons) {
            try {
                const coupons = JSON.parse(survey.issued_coupons || '[]');
                if (Array.isArray(coupons)) {
                    // Add coupon count
                    rows.push({
                        survey_id: survey.survey_response_id,
                        participant_id: survey.participant_id,
                        variable: 'coupon_issued_count',
                        numeric_value: coupons.length,
                        text_value: null
                    });

                    // Add individual coupons
                    coupons.forEach((coupon, index) => {
                        rows.push({
                            survey_id: survey.survey_response_id,
                            participant_id: survey.participant_id,
                            variable: `coupon_issued_${index + 1}`,
                            numeric_value: null,
                            text_value: coupon
                        });
                    });
                }
            } catch (e) {
                console.error('Error parsing coupons for survey', survey.survey_response_id, e);
            }
        }

        if (!rows || rows.length === 0) {
            return 'survey_id,participant_id,variable,numeric_value,text_value\n';
        }

        return this.convertToCSV(rows);
    }

    /**
     * Export data in wide format
     * @param {string} valueType - 'text' or 'numeric'
     * @returns {Promise<string>} CSV string
     */
    async exportWideFormat(valueType = 'text') {
        // Use the exact same query structure as the API export endpoint
        // Exclude soft-deleted subjects (per Feature 4). Only the analytic
        // exports honor the flag — operational tables (uploads, audit) stay
        // unfiltered.
        const whereClause = 'cs.deleted_at IS NULL';
        const params = [];

        // First get the long format data - MUST match the long format export exactly
        const query = `
            -- Metadata fields
            SELECT
                cs.survey_response_id as survey_id,
                cs.participant_id,
                'meta_survey_id' as variable,
                NULL as numeric_value,
                cs.survey_response_id as text_value
            FROM completed_surveys cs
            WHERE ${whereClause}

            UNION ALL

            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'meta_participant_id' as variable,
                NULL,
                cs.participant_id
            FROM completed_surveys cs
            WHERE ${whereClause}

            UNION ALL

            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'meta_facility_id' as variable,
                cs.facility_id,
                NULL
            FROM completed_surveys cs
            WHERE ${whereClause}

            UNION ALL

            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'meta_facility_name' as variable,
                NULL,
                f.name
            FROM completed_surveys cs
            JOIN facilities f ON cs.facility_id = f.id
            WHERE ${whereClause}

            UNION ALL

            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'meta_started_at' as variable,
                NULL,
                cs.started_at
            FROM completed_surveys cs
            WHERE ${whereClause}

            UNION ALL

            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'meta_completed_at' as variable,
                NULL,
                cs.completed_at
            FROM completed_surveys cs
            WHERE ${whereClause}

            UNION ALL

            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'meta_language' as variable,
                NULL,
                cs.language
            FROM completed_surveys cs
            WHERE ${whereClause}

            UNION ALL

            -- Device information
            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'device_id' as variable,
                NULL,
                cs.device_id
            FROM completed_surveys cs
            WHERE ${whereClause} AND cs.device_id IS NOT NULL

            UNION ALL

            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'device_model' as variable,
                NULL,
                cs.device_model
            FROM completed_surveys cs
            WHERE ${whereClause} AND cs.device_model IS NOT NULL

            UNION ALL

            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'device_android_version' as variable,
                NULL,
                cs.android_version
            FROM completed_surveys cs
            WHERE ${whereClause} AND cs.android_version IS NOT NULL

            UNION ALL

            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'device_app_version' as variable,
                NULL,
                cs.app_version
            FROM completed_surveys cs
            WHERE ${whereClause} AND cs.app_version IS NOT NULL

            UNION ALL

            -- Coupon information
            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'coupon_referral_used' as variable,
                NULL,
                cs.referral_coupon_code
            FROM completed_surveys cs
            WHERE ${whereClause} AND cs.referral_coupon_code IS NOT NULL

            UNION ALL

            -- Survey question responses
            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'q_' || sr.question_short_name as variable,
                CASE
                    WHEN sr.answer_type = 'multiple_choice' THEN sr.response_option_index
                    WHEN sr.answer_type = 'numeric' THEN CAST(sr.response_value AS REAL)
                    ELSE NULL
                END as numeric_value,
                CASE
                    WHEN sr.answer_type = 'multiple_choice' THEN sr.response_option_text
                    WHEN sr.answer_type = 'multi_select' THEN sr.response_multi_indices
                    ELSE sr.response_value
                END as text_value
            FROM completed_surveys cs
            JOIN survey_responses sr ON cs.id = sr.completed_survey_id
            WHERE ${whereClause} AND sr.question_short_name IS NOT NULL

            UNION ALL

            -- "Other, specify" free text, as q_<short_name>_other
            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'q_' || sr.question_short_name || '_other' as variable,
                NULL as numeric_value,
                sr.response_other_text as text_value
            FROM completed_surveys cs
            JOIN survey_responses sr ON cs.id = sr.completed_survey_id
            WHERE ${whereClause} AND sr.question_short_name IS NOT NULL
              AND sr.response_other_text IS NOT NULL

            UNION ALL

            -- Rapid test results
            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'rapid_' || rt.test_id || '_result' as variable,
                NULL,
                rt.result
            FROM completed_surveys cs
            JOIN rapid_test_results rt ON cs.id = rt.completed_survey_id
            WHERE ${whereClause}

            UNION ALL

            -- Lab results
            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'lab_' || REPLACE(LOWER(ltc.test_name), ' ', '_') as variable,
                lr.result_numeric,
                lr.result_value
            FROM completed_surveys cs
            JOIN lab_results lr ON cs.participant_id = lr.subject_id
            JOIN lab_test_configurations ltc ON lr.test_id = ltc.id
            WHERE ${whereClause}

            UNION ALL

            -- Payment information
            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'pay_confirmed' as variable,
                CASE WHEN sp.payment_confirmed = 1 THEN 1 ELSE 0 END,
                NULL
            FROM completed_surveys cs
            LEFT JOIN survey_payments sp ON cs.id = sp.completed_survey_id
            WHERE ${whereClause}

            UNION ALL

            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'pay_amount' as variable,
                sp.payment_amount,
                NULL
            FROM completed_surveys cs
            JOIN survey_payments sp ON cs.id = sp.completed_survey_id
            WHERE ${whereClause} AND sp.payment_amount IS NOT NULL

            UNION ALL

            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'pay_type' as variable,
                NULL,
                sp.payment_type
            FROM completed_surveys cs
            JOIN survey_payments sp ON cs.id = sp.completed_survey_id
            WHERE ${whereClause} AND sp.payment_type IS NOT NULL

            UNION ALL

            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'pay_date' as variable,
                NULL,
                sp.payment_date
            FROM completed_surveys cs
            JOIN survey_payments sp ON cs.id = sp.completed_survey_id
            WHERE ${whereClause} AND sp.payment_date IS NOT NULL

            UNION ALL

            SELECT
                cs.survey_response_id,
                cs.participant_id,
                'sample_collected' as variable,
                CASE WHEN sp.sample_collected = 1 THEN 1 ELSE 0 END,
                NULL
            FROM completed_surveys cs
            LEFT JOIN survey_payments sp ON cs.id = sp.completed_survey_id
            WHERE ${whereClause}

            ORDER BY survey_id, variable
        `;

        const rawLongRows = await allAsync(query, params);
        const multiSelectMeta = await this.loadMultiSelectMeta();
        const longRows = this.expandMultiSelectRows(rawLongRows, multiSelectMeta);

        // Process issued coupons (from JSON) - same as API export
        const surveysWithCoupons = await allAsync(`
            SELECT survey_response_id, participant_id, issued_coupons
            FROM completed_surveys cs
            WHERE ${whereClause} AND issued_coupons IS NOT NULL
        `, params);

        for (const survey of surveysWithCoupons) {
            try {
                const coupons = JSON.parse(survey.issued_coupons || '[]');
                if (Array.isArray(coupons)) {
                    // Add coupon count
                    longRows.push({
                        survey_id: survey.survey_response_id,
                        participant_id: survey.participant_id,
                        variable: 'coupon_issued_count',
                        numeric_value: coupons.length,
                        text_value: null
                    });

                    // Add individual coupons
                    coupons.forEach((coupon, index) => {
                        longRows.push({
                            survey_id: survey.survey_response_id,
                            participant_id: survey.participant_id,
                            variable: `coupon_issued_${index + 1}`,
                            numeric_value: null,
                            text_value: coupon
                        });
                    });
                }
            } catch (e) {
                console.error('Error parsing coupons for survey', survey.survey_response_id, e);
            }
        }

        if (!longRows || longRows.length === 0) {
            return 'survey_id,participant_id\n';
        }

        // Get question order from database for sorting q_ columns
        const questionOrder = await allAsync(`
            SELECT short_name, question_index
            FROM questions
            WHERE short_name IS NOT NULL
            ORDER BY question_index
        `);
        // Each q_ column sorts by (question position, owning question,
        // sub-position), so a question's own columns — the answer, exploded
        // multi-select options q_foo_<i>, and "other" text q_foo_other — stay
        // together even when questions from different surveys share a position.
        const questionOrderMap = {};
        questionOrder.forEach((q, index) => {
            questionOrderMap['q_' + q.short_name] = { base: q.question_index ?? index, group: q.short_name, sub: 0 };
        });
        // Exploded multi-select columns, ordered by option_index (handles
        // two-digit indices correctly, unlike a plain lexicographic fallback).
        for (const [shortName, optionIndices] of Object.entries(multiSelectMeta)) {
            const base = questionOrderMap['q_' + shortName]?.base ?? 999999;
            for (const idx of optionIndices) {
                questionOrderMap[`q_${shortName}_${idx}`] = { base, group: shortName, sub: 1 + idx / 10000 };
            }
        }
        // "Other" text columns (q_foo_other) go right after the question's own
        // column(s), including any exploded multi-select columns. A real
        // question that happens to be named foo_other keeps its own position.
        for (const q of questionOrder) {
            const otherColumn = `q_${q.short_name}_other`;
            if (!(otherColumn in questionOrderMap)) {
                questionOrderMap[otherColumn] = { ...questionOrderMap['q_' + q.short_name], sub: 2 };
            }
        }
        const NO_ORDER = { base: 999999, group: '', sub: 0 };

        // Pivot to wide format
        const wideData = {};
        const allColumns = new Set(['survey_id', 'participant_id']);

        // Group by survey_id
        for (const row of longRows) {
            if (!wideData[row.survey_id]) {
                wideData[row.survey_id] = {
                    survey_id: row.survey_id,
                    participant_id: row.participant_id
                };
            }

            // Add the variable as a column
            // Determine which value to use based on valueType parameter
            let value;
            if (valueType === 'text') {
                // Use text when available, otherwise use numeric
                value = row.text_value !== null && row.text_value !== undefined && row.text_value !== ''
                    ? row.text_value
                    : row.numeric_value;
            } else {
                // Default behavior: use numeric when available, otherwise use text
                value = row.numeric_value !== null && row.numeric_value !== undefined
                    ? row.numeric_value
                    : row.text_value;
            }

            wideData[row.survey_id][row.variable] = value;
            allColumns.add(row.variable);
        }

        // Convert to array and sort columns
        const wideRows = Object.values(wideData);
        const sortedColumns = Array.from(allColumns).sort((a, b) => {
            // Sort order: survey_id, participant_id, meta_, device_, q_, rapid_, lab_, pay_, sample_, coupon_
            const order = ['survey_id', 'participant_id'];
            const prefixes = ['meta_', 'device_', 'q_', 'rapid_', 'lab_', 'pay_', 'sample_', 'coupon_'];

            if (order.includes(a)) return order.includes(b) ? order.indexOf(a) - order.indexOf(b) : -1;
            if (order.includes(b)) return 1;

            const prefixA = prefixes.find(p => a.startsWith(p));
            const prefixB = prefixes.find(p => b.startsWith(p));

            if (prefixA && prefixB) {
                if (prefixA === prefixB) {
                    // For question columns, use display_order instead of alphabetical
                    if (prefixA === 'q_') {
                        const oa = questionOrderMap[a] ?? NO_ORDER;
                        const ob = questionOrderMap[b] ?? NO_ORDER;
                        return (oa.base - ob.base) || oa.group.localeCompare(ob.group) || (oa.sub - ob.sub);
                    }
                    return a.localeCompare(b);
                }
                return prefixes.indexOf(prefixA) - prefixes.indexOf(prefixB);
            }
            if (prefixA) return -1;
            if (prefixB) return 1;

            return a.localeCompare(b);
        });

        // Build CSV headers
        const headers = sortedColumns.join(',');
        const csvRows = [headers];

        // Add data rows
        for (const row of wideRows) {
            const values = sortedColumns.map(col => {
                const value = row[col];
                if (value === null || value === undefined) return '';
                const stringValue = this.forSpreadsheet ? neutralizeFormula(value) : String(value);
                if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
                    return `"${stringValue.replace(/"/g, '""')}"`;
                }
                return stringValue;
            });
            csvRows.push(values.join(','));
        }

        return csvRows.join('\n');
    }

    /**
     * Extract English text from JSON string
     */
    extractEnglishText(jsonStr) {
        if (!jsonStr) return '';
        try {
            const obj = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
            return obj.en || obj.text || '';
        } catch {
            return jsonStr || '';
        }
    }

    /**
     * Convert array of objects to CSV string
     */
    convertToCSV(data) {
        if (!data || data.length === 0) return '';

        const headers = Object.keys(data[0]);
        const csvRows = [];

        // Add headers
        csvRows.push(headers.join(','));

        // Add data rows
        for (const row of data) {
            const values = headers.map(header => {
                const value = row[header];
                // Escape and quote values
                if (value === null || value === undefined) return '';
                const stringValue = this.forSpreadsheet ? neutralizeFormula(value) : String(value);
                if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
                    return `"${stringValue.replace(/"/g, '""')}"`;
                }
                return stringValue;
            });
            csvRows.push(values.join(','));
        }

        return csvRows.join('\n');
    }
}

module.exports = DataExporter;