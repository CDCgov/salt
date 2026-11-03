const { neutralizeFormula } = require('./csvSafety');
const fs = require('fs').promises;
const path = require('path');
const glob = require('path');

const uploadsDir = path.join(__dirname, '..', '..', 'data', 'uploads');

class PaymentExporter {
    /**
     * Export all payment records from JSON files as CSV.
     * Sources: surveys/ (participation) and recruitment_payments/ (recruitment)
     * @returns {Promise<string>} CSV string
     */
    async exportCSV() {
        const rows = [];

        // 1. Participation payments from survey JSON files
        await this._processSurveyFiles(rows);

        // 2. Recruitment payments from recruitment_payments JSON files
        await this._processRecruitmentFiles(rows);

        // Sort by payment date
        rows.sort((a, b) => (a.payment_date || '').localeCompare(b.payment_date || ''));

        if (rows.length === 0) {
            return 'subject_id,facility_id,facility_name,payment_type,payment_amount,payment_date,phone_number,fingerprint,signature\n';
        }

        const headers = 'subject_id,facility_id,facility_name,payment_type,payment_amount,payment_date,phone_number,fingerprint,signature';
        const csvRows = [headers];
        for (const row of rows) {
            csvRows.push([
                this._csvEscape(row.subject_id),
                this._csvEscape(row.facility_id),
                this._csvEscape(row.facility_name),
                this._csvEscape(row.payment_type),
                this._csvEscape(row.payment_amount),
                this._csvEscape(row.payment_date),
                this._csvEscape(row.phone_number),
                this._csvEscape(row.fingerprint),
                this._csvEscape(row.signature),
            ].join(','));
        }
        return csvRows.join('\n');
    }

    async _processSurveyFiles(rows) {
        const dir = path.join(uploadsDir, 'surveys');
        let files;
        try {
            files = await fs.readdir(dir);
        } catch {
            return; // directory doesn't exist
        }

        for (const file of files) {
            if (!file.endsWith('.json')) continue;
            try {
                const raw = await fs.readFile(path.join(dir, file), 'utf-8');
                const data = JSON.parse(raw);
                const sd = data.survey_data || data;

                // Skip if no payment confirmed
                if (!sd.paymentConfirmed) continue;

                rows.push({
                    subject_id: sd.subjectId || sd.participantId || '',
                    facility_id: data.facility_id != null ? String(data.facility_id) : '',
                    facility_name: data.facility_name || '',
                    payment_type: 'participation',
                    payment_amount: sd.paymentAmount != null ? String(sd.paymentAmount) : '',
                    payment_date: sd.paymentDate || '',
                    phone_number: sd.paymentPhoneNumber || '',
                    fingerprint: sd.fingerprintVerified ? 'yes' : 'no',
                    signature: sd.consentSignaturePath ? 'yes' : 'no',
                });
            } catch (err) {
                // Skip unreadable files
            }
        }
    }

    async _processRecruitmentFiles(rows) {
        const dir = path.join(uploadsDir, 'recruitment_payments');
        let files;
        try {
            files = await fs.readdir(dir);
        } catch {
            return; // directory doesn't exist
        }

        for (const file of files) {
            if (!file.endsWith('.json')) continue;
            // Skip dev log uploads
            if (file.includes('LOG_UPLOAD')) continue;
            try {
                const raw = await fs.readFile(path.join(dir, file), 'utf-8');
                const data = JSON.parse(raw);
                const pd = data.payment_data || {};

                rows.push({
                    subject_id: data.subject_id || '',
                    facility_id: data.facility_id != null ? String(data.facility_id) : '',
                    facility_name: data.facility_name || '',
                    payment_type: 'recruitment',
                    payment_amount: pd.totalAmount != null ? String(pd.totalAmount) : '',
                    payment_date: pd.paymentDate || '',
                    phone_number: pd.phone || '',
                    fingerprint: pd.confirmationMethod === 'fingerprint' ? 'yes' : 'no',
                    signature: pd.signatureHex ? 'yes' : 'no',
                });
            } catch (err) {
                // Skip unreadable files
            }
        }
    }

    _csvEscape(value) {
        if (value === null || value === undefined) return '';
        const str = neutralizeFormula(value); // download-only file
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    }
}

module.exports = PaymentExporter;
