/**
 * Database initialization
 *
 * Creates the full SALT schema from scratch in one shot. Replaces the older
 * core-tables-plus-27-migration-files approach so a fresh deployment (Docker
 * or otherwise) ends up with a complete, current schema in one step.
 *
 * Re-runnable: every DDL uses IF NOT EXISTS, the VIEW/TRIGGER are dropped and
 * recreated, the default admin is INSERT OR IGNORE, the sample survey is only
 * created if no surveys exist. Safe to run against an empty DB or an existing
 * one already at this schema.
 */

const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { importSurveyBundle } = require('../src/services/surveyImport');

const dbPath = process.env.SALT_DB_PATH
    || path.join(__dirname, '..', 'data', 'database', 'salt.db');
const dbDir = path.dirname(dbPath);

// Survey export bundle seeded into a fresh database — see seedShortMsmSurvey().
const SEED_SURVEY_PATH = path.join(__dirname, 'crane4_short_msm_survey.json');

if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const SCHEMA_SQL = `
-- ============================================================================
-- Facilities & configuration
-- ============================================================================
CREATE TABLE IF NOT EXISTS facilities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    location TEXT,
    api_key TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    allow_non_coupon_participants BOOLEAN DEFAULT 1,
    coupons_to_issue INTEGER DEFAULT 3,
    seed_recruitment_active BOOLEAN DEFAULT 0,
    seed_contact_rate_days INTEGER DEFAULT 7,
    seed_recruitment_window_min_days INTEGER DEFAULT 0,
    seed_recruitment_window_max_days INTEGER DEFAULT 730,
    subject_payment_type TEXT DEFAULT 'None',
    participation_payment_amount REAL DEFAULT 0,
    recruitment_payment_amount REAL DEFAULT 0,
    payment_currency TEXT DEFAULT 'USD',
    payment_currency_symbol TEXT DEFAULT '$'
);

CREATE TABLE IF NOT EXISTS facility_short_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    short_code TEXT UNIQUE NOT NULL,
    facility_id INTEGER NOT NULL,
    api_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    used_at DATETIME,
    used_by_ip TEXT,
    FOREIGN KEY (facility_id) REFERENCES facilities(id) ON DELETE CASCADE
);

-- ============================================================================
-- Survey definition
-- ============================================================================
CREATE TABLE IF NOT EXISTS surveys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    languages TEXT DEFAULT '["en"]',
    is_active BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    eligibility_script TEXT,
    eligibility_message_json TEXT DEFAULT '{"English": "Thank you for your interest. Unfortunately, you do not meet the eligibility criteria for this survey."}',
    base_survey_id INTEGER,
    parent_survey_id INTEGER REFERENCES surveys(id),
    version_notes TEXT,
    is_draft BOOLEAN DEFAULT 1,
    fingerprint_enabled BOOLEAN DEFAULT 0,
    re_enrollment_days INTEGER DEFAULT 90,
    staff_validation_message_json TEXT,
    hiv_rapid_test_enabled INTEGER DEFAULT 1,
    contact_info_enabled BOOLEAN DEFAULT 0,
    staff_eligibility_screening BOOLEAN DEFAULT 0,
    rapid_test_samples_after_eligibility BOOLEAN DEFAULT 1,
    payment_audit_phone_enabled INTEGER DEFAULT 0,
    coupon_count_script TEXT
);

CREATE TABLE IF NOT EXISTS sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    survey_id INTEGER NOT NULL,
    section_index INTEGER NOT NULL,
    section_type TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (survey_id) REFERENCES surveys(id)
);

CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    survey_id INTEGER,
    question_index INTEGER,
    short_name TEXT,
    question_text_json TEXT NOT NULL,
    audio_files_json TEXT DEFAULT '{}',
    question_type TEXT DEFAULT 'multiple_choice',
    validation_script TEXT,
    validation_error_json TEXT DEFAULT '{"en": "Invalid answer"}',
    pre_script TEXT,
    section_id INTEGER REFERENCES sections(id),
    min_selections INTEGER DEFAULT NULL,
    max_selections INTEGER DEFAULT NULL,
    skip_to_script TEXT DEFAULT NULL,
    skip_to_target TEXT DEFAULT NULL,
    FOREIGN KEY (survey_id) REFERENCES surveys(id)
);

CREATE TABLE IF NOT EXISTS options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id INTEGER,
    option_index INTEGER,
    option_text_json TEXT NOT NULL,
    audio_files_json TEXT DEFAULT '{}',
    option_value TEXT,
    FOREIGN KEY (question_id) REFERENCES questions(id)
);

CREATE TABLE IF NOT EXISTS survey_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    survey_id INTEGER NOT NULL,
    message_key TEXT NOT NULL,
    display_order INTEGER DEFAULT 0,
    message_text_json TEXT NOT NULL,
    audio_files_json TEXT DEFAULT '{}',
    message_type TEXT DEFAULT 'system',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (survey_id) REFERENCES surveys(id) ON DELETE CASCADE,
    UNIQUE(survey_id, message_key)
);

CREATE TABLE IF NOT EXISTS test_configurations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    survey_id INTEGER NOT NULL,
    test_id TEXT NOT NULL,
    test_name TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT 0,
    display_order INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (survey_id) REFERENCES surveys(id) ON DELETE CASCADE,
    UNIQUE(survey_id, test_id)
);

CREATE TABLE IF NOT EXISTS lab_test_configurations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    test_name TEXT NOT NULL UNIQUE,
    test_code TEXT UNIQUE,
    test_type TEXT NOT NULL CHECK(test_type IN ('dropdown', 'numeric')),
    options TEXT,
    min_value REAL,
    max_value REAL,
    unit TEXT,
    description TEXT,
    display_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    jexl_condition TEXT
);

-- ============================================================================
-- Recruitment + coupons
-- ============================================================================
CREATE TABLE IF NOT EXISTS recruitment_pools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    criteria TEXT,
    target_size INTEGER,
    sampling_rate REAL,
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS coupons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    pool_id INTEGER,
    distributor_survey_id TEXT,
    recipient_survey_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    used_at DATETIME,
    FOREIGN KEY (pool_id) REFERENCES recruitment_pools(id)
);

CREATE TABLE IF NOT EXISTS coupon_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coupon_code TEXT UNIQUE NOT NULL,
    issued_by_survey_id TEXT,
    used_by_survey_id TEXT,
    issued_at DATETIME,
    used_at DATETIME,
    facility_id INTEGER,
    FOREIGN KEY (facility_id) REFERENCES facilities(id)
);

-- ============================================================================
-- Survey responses + completed surveys
-- ============================================================================
CREATE TABLE IF NOT EXISTS completed_surveys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    survey_response_id TEXT UNIQUE NOT NULL,
    participant_id TEXT NOT NULL,
    survey_id INTEGER NOT NULL,
    facility_id INTEGER NOT NULL,
    started_at DATETIME NOT NULL,
    completed_at DATETIME NOT NULL,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    language TEXT NOT NULL,
    survey_version INTEGER,
    device_id TEXT,
    device_model TEXT,
    android_version TEXT,
    app_version TEXT,
    referral_coupon_code TEXT,
    issued_coupons TEXT,
    recruiter_survey_id TEXT,
    recruitment_depth INTEGER DEFAULT 0,
    json_file_path TEXT,
    consent_signature_path TEXT DEFAULT NULL,
    deleted_at DATETIME DEFAULT NULL,
    deleted_by INTEGER DEFAULT NULL,
    FOREIGN KEY (survey_id) REFERENCES surveys(id),
    FOREIGN KEY (facility_id) REFERENCES facilities(id)
);

CREATE TABLE IF NOT EXISTS survey_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    completed_survey_id INTEGER NOT NULL,
    question_id INTEGER,
    question_index INTEGER NOT NULL,
    question_short_name TEXT,
    response_value TEXT,
    response_option_index INTEGER,
    response_option_text TEXT,
    response_multi_indices TEXT,
    answer_type TEXT NOT NULL,
    FOREIGN KEY (completed_survey_id) REFERENCES completed_surveys(id) ON DELETE CASCADE,
    FOREIGN KEY (question_id) REFERENCES questions(id)
);

CREATE TABLE IF NOT EXISTS rapid_test_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    completed_survey_id INTEGER NOT NULL,
    test_id TEXT NOT NULL,
    test_name TEXT NOT NULL,
    result TEXT NOT NULL,
    recorded_at DATETIME NOT NULL,
    FOREIGN KEY (completed_survey_id) REFERENCES completed_surveys(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS lab_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id TEXT NOT NULL,
    test_id INTEGER NOT NULL,
    result_value TEXT,
    result_numeric REAL,
    submitted_by INTEGER NOT NULL,
    file_path TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (test_id) REFERENCES lab_test_configurations(id),
    FOREIGN KEY (submitted_by) REFERENCES admin_users(id)
);

CREATE TABLE IF NOT EXISTS survey_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    completed_survey_id INTEGER NOT NULL UNIQUE,
    payment_confirmed BOOLEAN DEFAULT 0,
    payment_amount REAL,
    payment_type TEXT,
    payment_date DATETIME,
    sample_collected BOOLEAN DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (completed_survey_id) REFERENCES completed_surveys(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    survey_response_id TEXT UNIQUE NOT NULL,
    facility_id INTEGER,
    upload_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    file_path TEXT,
    status TEXT,
    participant_id TEXT,
    FOREIGN KEY (facility_id) REFERENCES facilities(id)
);

-- ============================================================================
-- Users + audit
-- ============================================================================
CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    email TEXT UNIQUE,
    full_name TEXT,
    role TEXT NOT NULL DEFAULT 'administrator' CHECK(role IN ('administrator', 'lab_staff')),
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    old_value TEXT,
    new_value TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- Reports
-- ============================================================================
CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    qmd_content TEXT NOT NULL,
    is_active BOOLEAN DEFAULT 1,
    created_by INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES admin_users(id)
);

CREATE TABLE IF NOT EXISTS report_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL,
    schedule_type VARCHAR(50) NOT NULL,
    schedule_time TIME NOT NULL,
    schedule_day INTEGER,
    is_active BOOLEAN DEFAULT 1,
    last_run TIMESTAMP,
    next_run TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS report_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL,
    run_id VARCHAR(36) NOT NULL UNIQUE,
    run_type VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    error_message TEXT,
    log_output TEXT,
    output_path VARCHAR(500),
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS report_outputs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id VARCHAR(36) NOT NULL,
    file_type VARCHAR(10) NOT NULL,
    file_path VARCHAR(500) NOT NULL,
    file_size INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (run_id) REFERENCES report_runs(run_id) ON DELETE CASCADE
);

-- ============================================================================
-- Indexes
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_uploads_facility ON uploads(facility_id);
CREATE INDEX IF NOT EXISTS idx_uploads_status ON uploads(status);
CREATE INDEX IF NOT EXISTS idx_questions_survey ON questions(survey_id);
CREATE INDEX IF NOT EXISTS idx_questions_section ON questions(section_id);
CREATE INDEX IF NOT EXISTS idx_questions_skip_target ON questions(skip_to_target);
CREATE INDEX IF NOT EXISTS idx_options_question ON options(question_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons(code);
CREATE INDEX IF NOT EXISTS idx_sections_survey ON sections(survey_id);
CREATE INDEX IF NOT EXISTS idx_surveys_base ON surveys(base_survey_id);
CREATE INDEX IF NOT EXISTS idx_surveys_parent ON surveys(parent_survey_id);
CREATE INDEX IF NOT EXISTS idx_survey_messages_survey ON survey_messages(survey_id);
CREATE INDEX IF NOT EXISTS idx_survey_messages_key ON survey_messages(message_key);
CREATE INDEX IF NOT EXISTS idx_short_code ON facility_short_codes(short_code);
CREATE INDEX IF NOT EXISTS idx_facility_id ON facility_short_codes(facility_id);
CREATE INDEX IF NOT EXISTS idx_expires_at ON facility_short_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_test_configurations_survey ON test_configurations(survey_id);
CREATE INDEX IF NOT EXISTS idx_admin_users_role ON admin_users(role);
CREATE INDEX IF NOT EXISTS idx_admin_users_email ON admin_users(email);
CREATE INDEX IF NOT EXISTS idx_admin_users_username ON admin_users(username);
CREATE INDEX IF NOT EXISTS idx_lab_results_subject_id ON lab_results(subject_id);
CREATE INDEX IF NOT EXISTS idx_lab_results_test_id ON lab_results(test_id);
CREATE INDEX IF NOT EXISTS idx_lab_results_submitted_by ON lab_results(submitted_by);
CREATE INDEX IF NOT EXISTS idx_lab_test_configurations_active ON lab_test_configurations(is_active);
CREATE INDEX IF NOT EXISTS idx_lab_test_configurations_display_order ON lab_test_configurations(display_order);
CREATE INDEX IF NOT EXISTS idx_participant_id ON completed_surveys(participant_id);
CREATE INDEX IF NOT EXISTS idx_completed_at ON completed_surveys(completed_at);
CREATE INDEX IF NOT EXISTS idx_referral_coupon ON completed_surveys(referral_coupon_code);
CREATE INDEX IF NOT EXISTS idx_survey_id ON completed_surveys(survey_id);
CREATE INDEX IF NOT EXISTS idx_completed_surveys_deleted_at ON completed_surveys(deleted_at);
CREATE INDEX IF NOT EXISTS idx_survey_responses ON survey_responses(completed_survey_id);
CREATE INDEX IF NOT EXISTS idx_question_responses ON survey_responses(question_id);
CREATE INDEX IF NOT EXISTS idx_response_question_name ON survey_responses(question_short_name);
CREATE INDEX IF NOT EXISTS idx_test_survey ON rapid_test_results(completed_survey_id);
CREATE INDEX IF NOT EXISTS idx_test_result ON rapid_test_results(result);
CREATE INDEX IF NOT EXISTS idx_coupon_code ON coupon_usage(coupon_code);
CREATE INDEX IF NOT EXISTS idx_issued_by ON coupon_usage(issued_by_survey_id);
CREATE INDEX IF NOT EXISTS idx_used_by ON coupon_usage(used_by_survey_id);
CREATE INDEX IF NOT EXISTS idx_payment_survey ON survey_payments(completed_survey_id);
CREATE INDEX IF NOT EXISTS idx_report_runs_report_id ON report_runs(report_id);
CREATE INDEX IF NOT EXISTS idx_report_runs_status ON report_runs(status);
CREATE INDEX IF NOT EXISTS idx_report_runs_run_id ON report_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_report_outputs_run_id ON report_outputs(run_id);
CREATE INDEX IF NOT EXISTS idx_report_schedules_report_id ON report_schedules(report_id);
CREATE INDEX IF NOT EXISTS idx_report_schedules_next_run ON report_schedules(next_run);

-- ============================================================================
-- Views + triggers (drop-and-recreate, since SQLite doesn't have CREATE OR REPLACE)
-- ============================================================================
DROP VIEW IF EXISTS latest_survey_versions;
CREATE VIEW latest_survey_versions AS
SELECT s1.*
FROM surveys s1
WHERE s1.version = (
    SELECT MAX(s2.version)
    FROM surveys s2
    WHERE s2.base_survey_id = s1.base_survey_id
    OR (s2.id = s1.id AND s1.base_survey_id IS NULL)
);

DROP TRIGGER IF EXISTS update_admin_users_timestamp;
CREATE TRIGGER update_admin_users_timestamp
AFTER UPDATE ON admin_users
FOR EACH ROW
BEGIN
    UPDATE admin_users SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

DROP TRIGGER IF EXISTS update_lab_test_configurations_timestamp;
CREATE TRIGGER update_lab_test_configurations_timestamp
AFTER UPDATE ON lab_test_configurations
BEGIN
    UPDATE lab_test_configurations SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- MCP report-builder: OAuth 2.1 authorization server + sessions.
-- (Also available as a standalone migration: scripts/add-mcp.sql)
CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id TEXT PRIMARY KEY,
    client_secret_hash TEXT,
    client_name TEXT,
    redirect_uris TEXT NOT NULL,
    grant_types TEXT DEFAULT '["authorization_code","refresh_token"]',
    token_endpoint_auth_method TEXT DEFAULT 'none',
    metadata_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS oauth_auth_codes (
    code TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT,
    code_challenge_method TEXT DEFAULT 'S256',
    scope TEXT,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS mcp_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    client_id TEXT,
    access_token_hash TEXT,
    refresh_token_hash TEXT,
    scope TEXT,
    issued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    access_expires_at DATETIME NOT NULL,
    absolute_expires_at DATETIME NOT NULL,
    last_used_at DATETIME,
    revoked INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_access ON mcp_sessions(access_token_hash);
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_refresh ON mcp_sessions(refresh_token_hash);
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_user ON mcp_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_auth_codes_expiry ON oauth_auth_codes(expires_at);
`;

const SAMPLE_SURVEY = {
    name: 'SALT HIV Survey',
    description: 'Sample HIV monitoring survey for key populations',
    languages: '["English", "Swahili"]',
    questions: [
        {
            short_name: 'consent',
            question_text: '{"English": "Do you consent to participate in this survey?", "Swahili": "Je, unakubali kushiriki katika utafiti huu?"}',
            question_type: 'multiple_choice',
            options: [
                { text: '{"English": "Yes", "Swahili": "Ndio"}', value: '1' },
                { text: '{"English": "No", "Swahili": "Hapana"}', value: '0' }
            ]
        },
        {
            short_name: 'age',
            question_text: '{"English": "What is your age?", "Swahili": "Una umri gani?"}',
            question_type: 'numeric',
            validation_script: 'age >= 18 && age <= 100',
            validation_error: '{"English": "Age must be between 18 and 100", "Swahili": "Umri lazima uwe kati ya 18 na 100"}',
            pre_script: 'consent == "1"'
        },
        {
            short_name: 'gender',
            question_text: '{"English": "What is your gender?", "Swahili": "Jinsia yako ni gani?"}',
            question_type: 'multiple_choice',
            pre_script: 'consent == "1"',
            options: [
                { text: '{"English": "Male", "Swahili": "Mwanaume"}', value: 'male' },
                { text: '{"English": "Female", "Swahili": "Mwanamke"}', value: 'female' },
                { text: '{"English": "Other", "Swahili": "Nyingine"}', value: 'other' }
            ]
        },
        {
            short_name: 'hiv_tested',
            question_text: '{"English": "Have you been tested for HIV in the last 12 months?", "Swahili": "Je, umepimwa VVU katika miezi 12 iliyopita?"}',
            question_type: 'multiple_choice',
            pre_script: 'consent == "1" && age >= 18',
            options: [
                { text: '{"English": "Yes", "Swahili": "Ndio"}', value: 'yes' },
                { text: '{"English": "No", "Swahili": "Hapana"}', value: 'no' },
                { text: '{"English": "Prefer not to answer", "Swahili": "Napendelea kutokjibu"}', value: 'no_answer' }
            ]
        },
        {
            short_name: 'test_result',
            question_text: '{"English": "What was your most recent HIV test result?", "Swahili": "Matokeo yako ya hivi karibuni ya kipimo cha VVU yalikuwa yapi?"}',
            question_type: 'multiple_choice',
            pre_script: 'hiv_tested == "yes"',
            options: [
                { text: '{"English": "Negative", "Swahili": "Hasi"}', value: 'negative' },
                { text: '{"English": "Positive", "Swahili": "Chanya"}', value: 'positive' },
                { text: '{"English": "Prefer not to answer", "Swahili": "Napendelea kutokjibu"}', value: 'no_answer' }
            ]
        },
        {
            short_name: 'on_treatment',
            question_text: '{"English": "Are you currently on HIV treatment?", "Swahili": "Je, kwa sasa unapata matibabu ya VVU?"}',
            question_type: 'multiple_choice',
            pre_script: 'test_result == "positive"',
            options: [
                { text: '{"English": "Yes", "Swahili": "Ndio"}', value: 'yes' },
                { text: '{"English": "No", "Swahili": "Hapana"}', value: 'no' }
            ]
        }
    ]
};

function runAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err); else resolve(this);
        });
    });
}

function getAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err); else resolve(row);
        });
    });
}

function allAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err); else resolve(rows || []);
        });
    });
}

function execAsync(db, sql) {
    return new Promise((resolve, reject) => {
        db.exec(sql, (err) => {
            if (err) reject(err); else resolve();
        });
    });
}

async function ensureDefaultAdmin(db) {
    const existing = await getAsync(db, 'SELECT COUNT(*) AS n FROM admin_users');
    if (existing && existing.n > 0) {
        console.log('Admin users already present, skipping default admin creation.');
        return;
    }
    const hash = await bcrypt.hash('admin123', 10);
    await runAsync(
        db,
        'INSERT OR IGNORE INTO admin_users (username, password_hash, role) VALUES (?, ?, ?)',
        ['admin', hash, 'administrator']
    );
    console.log('Default admin user created (username: admin, password: admin123). Change this on first login.');
}

async function ensureDemoFacility(db) {
    const existing = await getAsync(db, 'SELECT COUNT(*) AS n FROM facilities');
    if (existing && existing.n > 0) {
        console.log('Facilities already present, skipping demo facility creation.');
        return;
    }
    // Random API key so every deployment has a unique one. Operator should
    // rotate or replace it via the facility management UI before production.
    const apiKey = 'salt_' + crypto.randomUUID();
    await runAsync(
        db,
        `INSERT INTO facilities (name, location, api_key, allow_non_coupon_participants,
            coupons_to_issue, subject_payment_type, participation_payment_amount,
            recruitment_payment_amount, payment_currency, payment_currency_symbol)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        // subject_payment_type must be set (not the 'None' default) or the
        // tablet treats the facility as non-paying and hides the amount.
        ['Demo Facility', 'Example Location', apiKey, 1, 3, 'Cash', 10.0, 5.0, 'USD', '$']
    );
    console.log(`Demo facility created. API key: ${apiKey}`);
    console.log('  Use this key on a tablet to register it against this facility.');
}

async function ensureHivLabTests(db) {
    const existing = await getAsync(db, 'SELECT COUNT(*) AS n FROM lab_test_configurations');
    if (existing && existing.n > 0) {
        console.log('Lab tests already present, skipping HIV lab test seeds.');
        return;
    }
    // Three standard HIV monitoring labs. jexl_condition gates which subjects
    // each test applies to; an admin can refine these in the lab tests admin.
    const labs = [
        {
            test_name: 'HIV Confirmatory Test',
            test_code: 'HIVCONFIRM',
            test_type: 'dropdown',
            options: JSON.stringify(['Positive', 'Negative', 'Indeterminate']),
            min_value: null,
            max_value: null,
            unit: null,
            description: 'Confirmatory lab test for subjects whose rapid HIV test was positive.',
            display_order: 1,
            jexl_condition: "hivrapid == 'positive'"
        },
        {
            test_name: 'CD4 Count',
            test_code: 'CD4',
            test_type: 'numeric',
            options: null,
            min_value: 0,
            max_value: 5000,
            unit: 'cells/mm³',
            description: 'Absolute CD4 cell count for HIV-positive subjects.',
            display_order: 2,
            jexl_condition: "hivrapid == 'positive'"
        },
        {
            test_name: 'HIV Viral Load',
            test_code: 'VL',
            test_type: 'numeric',
            options: null,
            min_value: 0,
            max_value: 10000000,
            unit: 'copies/mL',
            description: 'HIV-1 RNA viral load for HIV-positive subjects.',
            display_order: 3,
            jexl_condition: "hivrapid == 'positive'"
        }
    ];
    for (const lab of labs) {
        await runAsync(
            db,
            `INSERT INTO lab_test_configurations
                (test_name, test_code, test_type, options, min_value, max_value, unit,
                 description, display_order, is_active, jexl_condition)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
            [lab.test_name, lab.test_code, lab.test_type, lab.options,
             lab.min_value, lab.max_value, lab.unit, lab.description,
             lab.display_order, lab.jexl_condition]
        );
    }
    console.log(`Seeded ${labs.length} HIV lab tests (HIV Confirmatory, CD4, Viral Load).`);
}

async function seedSampleSurvey(db) {
    // Seeded inactive — the Short MSM Survey is the only active survey.
    // hiv_rapid_test_enabled=0: HIV testing goes through the generic
    // test_configurations `hivrapid` entry below, matching the Short MSM Survey.
    const surveyResult = await runAsync(
        db,
        `INSERT INTO surveys (version, name, description, languages, is_active, hiv_rapid_test_enabled)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [1, SAMPLE_SURVEY.name, SAMPLE_SURVEY.description, SAMPLE_SURVEY.languages, 0, 0]
    );
    const surveyId = surveyResult.lastID;

    // Every survey must have exactly two sections: an 'eligibility' section
    // (index 0) and a 'main' section (index 1). Create them before the questions
    // so each question can be assigned to one (matches the create-survey path).
    const eligibilitySectionResult = await runAsync(
        db,
        `INSERT INTO sections (survey_id, section_index, section_type, name, description)
         VALUES (?, ?, ?, ?, ?)`,
        [surveyId, 0, 'eligibility', 'Eligibility', 'Screening questions to determine eligibility']
    );
    const mainSectionResult = await runAsync(
        db,
        `INSERT INTO sections (survey_id, section_index, section_type, name, description)
         VALUES (?, ?, ?, ?, ?)`,
        [surveyId, 1, 'main', 'Main', 'Primary survey questions']
    );
    const eligibilitySectionId = eligibilitySectionResult.lastID;
    const mainSectionId = mainSectionResult.lastID;
    // consent + age are the screening questions; everything else is the main body.
    const eligibilityShortNames = new Set(['consent', 'age']);

    for (let i = 0; i < SAMPLE_SURVEY.questions.length; i++) {
        const q = SAMPLE_SURVEY.questions[i];
        const sectionId = eligibilityShortNames.has(q.short_name) ? eligibilitySectionId : mainSectionId;
        const qResult = await runAsync(
            db,
            `INSERT INTO questions (survey_id, question_index, short_name, question_text_json,
                audio_files_json, question_type, validation_script, validation_error_json, pre_script, section_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [surveyId, i, q.short_name, q.question_text, '{}', q.question_type,
             q.validation_script || null, q.validation_error || null, q.pre_script || null, sectionId]
        );
        const questionId = qResult.lastID;
        if (q.options) {
            for (let j = 0; j < q.options.length; j++) {
                const opt = q.options[j];
                await runAsync(
                    db,
                    'INSERT INTO options (question_id, option_index, option_text_json, audio_files_json, option_value) VALUES (?, ?, ?, ?, ?)',
                    [questionId, j, opt.text, '{}', opt.value]
                );
            }
        }
    }
    // HIV rapid test — same `hivrapid` test_id the Short MSM Survey uses, so
    // the global lab tests (gated on `hivrapid == 'positive'`) apply here too.
    await runAsync(
        db,
        `INSERT INTO test_configurations (survey_id, test_id, test_name, enabled, display_order)
         VALUES (?, ?, ?, ?, ?)`,
        [surveyId, 'hivrapid', 'HIV Rapid Test', 1, 0]
    );
    console.log(`Sample survey created (id=${surveyId}, ${SAMPLE_SURVEY.questions.length} questions, inactive).`);
}

// Seed the packaged Short MSM Survey export bundle. Reuses the exact import
// code path the admin import endpoint uses (services/surveyImport), bound to
// this script's own sqlite handle. Imported active so a fresh deployment is
// ready to use without a manual activation step. A missing or malformed
// bundle is logged and skipped — it must never break database init.
async function seedShortMsmSurvey(db) {
    if (!fs.existsSync(SEED_SURVEY_PATH)) {
        console.warn(`Seed survey bundle not found at ${SEED_SURVEY_PATH}; skipping Short MSM survey.`);
        return;
    }
    let bundle;
    try {
        bundle = JSON.parse(fs.readFileSync(SEED_SURVEY_PATH, 'utf8'));
    } catch (err) {
        console.error(`Could not parse seed survey bundle (${err.message}); skipping Short MSM survey.`);
        return;
    }
    // importSurveyBundle is connection-agnostic — give it run/all bound to our
    // handle, normalising runAsync's resolved statement to { id, changes }.
    const dbx = {
        run: (sql, params) => runAsync(db, sql, params)
            .then(r => ({ id: r.lastID, changes: r.changes })),
        all: (sql, params) => allAsync(db, sql, params)
    };
    try {
        const result = await importSurveyBundle(dbx, bundle, { activate: true });
        for (const w of result.warnings) console.log(`  [seed] ${w}`);
        console.log(`Short MSM survey seeded (id=${result.surveyId}, v${result.version}: `
            + `${result.counts.questions} questions, ${result.counts.sections} sections, `
            + `${result.counts.options} options, ${result.counts.survey_messages} messages, `
            + `${result.counts.test_configurations} rapid tests). Active.`);
    } catch (err) {
        console.error(`Short MSM survey seed failed: ${err.message}`);
    }
}

// Surveys are seeded only into a fresh database (empty surveys table), so an
// existing deployment is never disturbed and re-runs are no-ops.
async function ensureSeedSurveys(db) {
    const existing = await getAsync(db, 'SELECT COUNT(*) AS n FROM surveys');
    if (existing && existing.n > 0) {
        console.log('Surveys already present, skipping survey seeding.');
        return;
    }
    await seedSampleSurvey(db);
    await seedShortMsmSurvey(db);
}

async function main() {
    const db = await new Promise((resolve, reject) => {
        const handle = new sqlite3.Database(dbPath, (err) => {
            if (err) reject(err); else resolve(handle);
        });
    });
    console.log(`Initializing database at ${dbPath}`);

    try {
        await execAsync(db, SCHEMA_SQL);
        console.log('Schema applied.');
        await ensureDefaultAdmin(db);
        await ensureDemoFacility(db);
        await ensureHivLabTests(db);
        await ensureSeedSurveys(db);
        console.log('Database initialization complete.');
    } catch (err) {
        console.error('Initialization failed:', err);
        process.exitCode = 1;
    } finally {
        await new Promise((resolve) => db.close(resolve));
    }
}

main();
