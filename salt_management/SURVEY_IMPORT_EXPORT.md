# Survey Import / Export — Specification

Lets an administrator export a survey's full configuration to a single JSON
file and import it into the same or a different SALT deployment. Use cases:
backup before risky edits, moving a survey from staging to production,
sharing survey templates across organizations, version-controlling surveys in
git, and seeding a new deployment with a pre-built questionnaire.

Implemented in `src/api/routes/surveyExport.js`, mounted at `/api`.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/api/admin/surveys/:id/export` | Download a survey as a JSON file |
| `POST` | `/api/admin/surveys/import`     | Create a new survey from an export file |

Both require an authenticated administrator session (`requireAdmin`).

## Export

### Included

For the given `survey_id`, the export bundles every table needed to
re-create the survey:

- The `surveys` row
- All `sections` for the survey
- All `questions` for the survey
- All `options` belonging to those questions
- All `survey_messages` for the survey
- All `test_configurations` for the survey

Audio is embedded as base64 inside the existing `audio_files_json` columns
(on questions, options, and survey messages), so the file is fully
self-contained — no separate asset shipping.

### Not included

- `lab_test_configurations` — global to a deployment, not per-survey.
- `facilities`, `admin_users`, completed survey data, coupons, audit logs.

### Bundle format

A single JSON object:

```json
{
  "schema_version": 1,
  "exported_at": "2026-05-20T12:34:56.789Z",
  "source": {
    "survey_name": "SALT HIV Survey",
    "survey_version": 3,
    "host": "drcmsm.surveysalt.com"
  },
  "survey": { "...": "object — see below" },
  "sections": [ "...array of section objects..." ],
  "questions": [ "...array of question objects..." ],
  "options": [ "...array of option objects..." ],
  "survey_messages": [ "...array of message objects..." ],
  "test_configurations": [ "...array of test-config objects..." ]
}
```

- `schema_version` — bundle format version. **Must be `1`.**
- `exported_at` — ISO 8601 timestamp. Informational; ignored on import.
- `source` — provenance metadata. Informational; ignored on import.

The remaining keys are arrays/objects of database rows. The full field
reference for each follows. **This section is the contract for generating a
valid bundle from scratch** (e.g. from a Word document describing a survey).

#### Two conventions that are easy to get wrong

**1. JSON-bearing columns are strings, not nested objects.** Several fields
hold JSON *as a string value* — the inner JSON is escaped. They are written
and read as strings. Correct:

```json
"question_text_json": "{\"en\":\"What is your age?\",\"fr\":\"Quel âge avez-vous ?\"}"
```

Wrong (do not emit a nested object):

```json
"question_text_json": { "en": "What is your age?" }
```

The string-typed-JSON fields are: `languages`, `eligibility_message_json`,
`staff_validation_message_json`, `question_text_json`,
`validation_error_json`, `audio_files_json`, `option_text_json`,
`message_text_json`.

**2. `id` fields are bundle-local link keys.** Each `section` and `question`
carries an `id`. These are **not** real database ids — on import every row
gets a fresh database id. They exist only so other rows can point at them
*within the bundle*:

- `question.section_id` must equal the `id` of a section in `sections` (or be `null`).
- `option.question_id` must equal the `id` of a question in `questions`.

Any integers work as long as they are unique within their array and the
references match. An option whose `question_id` matches no question is
**silently dropped**. A question whose `section_id` matches no section keeps
the row but loses its section link (with a warning).

#### Multilingual text objects

Fields ending in `_text_json` / `_message_json` hold an object keyed by
language identifier, e.g. `{"en":"...","fr":"..."}`. The keys must be
consistent with the survey's `languages` array and with the language
identifiers the tablet build expects. (Existing data uses a mix of language
codes like `"en"` and full names like `"English"` — match whatever the
`languages` array of the survey you are generating uses, and use it
consistently across every text object.)

#### `survey` object

The `surveys` row. The importer reads only the fields below; `id`,
`created_at`, `updated_at` are ignored if present. `is_active`, `is_draft`,
`base_survey_id`, `parent_survey_id` are **force-overridden** on import — you
may omit them.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | **yes** | Survey name. Import collision-checks on this. |
| `version` | integer | no (default 1) | Origin version. The new survey's version may be bumped — see Versioning. |
| `description` | string | no | Free text. |
| `languages` | JSON-string | no (default `"[\"en\"]"`) | JSON array of language identifiers, e.g. `"[\"en\",\"fr\"]"`. |
| `eligibility_script` | string (JEXL) | no | Expression deciding eligibility. |
| `coupon_count_script` | string (JEXL) | no | Evaluated at completion; can lower the coupons issued below the facility ceiling (number, or true/false for all/none). Blank = facility count. |
| `eligibility_message_json` | JSON-string | no | Multilingual "not eligible" message. |
| `version_notes` | string | no | Free text. |
| `fingerprint_enabled` | 0 / 1 | no | Whether fingerprint enrollment is used. |
| `re_enrollment_days` | integer | no (default 90) | Days before a participant may re-enroll. |
| `staff_validation_message_json` | JSON-string | no | Multilingual staff-validation message. |
| `hiv_rapid_test_enabled` | 0 / 1 | no | Whether the HIV rapid-test flow runs. |
| `contact_info_enabled` | 0 / 1 | no | Whether the contact-info screen is shown. |
| `staff_eligibility_screening` | 0 / 1 | no | Staff screens eligibility before handing over the tablet. |
| `rapid_test_samples_after_eligibility` | 0 / 1 | no | Sample collection happens right after eligibility. |
| `payment_audit_phone_enabled` | 0 / 1 | no | Whether a phone number is captured for payment audit. |

Force-overridden on import (omit or any value — ignored): `is_active` → 0,
`is_draft` → 1, `base_survey_id` → null, `parent_survey_id` → null.

#### `sections` array

**Every survey must contain exactly two sections — an Eligibility section and
a Main section.** The tablet relies on this; a survey missing either will not
run correctly. The importer does not enforce it, so a generated bundle must
always include both, exactly as follows:

| `section_index` | `section_type` | `name` |
|-----------------|----------------|--------|
| `0` | `eligibility` | `Eligibility` |
| `1` | `main` | `Main` |

The **Eligibility** section holds the screening questions whose answers the
survey's `eligibility_script` evaluates. The **Main** section holds the rest
of the questionnaire. Every question must be assigned (via `section_id`) to
one of these two sections.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | integer | **yes** | Bundle-local link key (see convention 2). |
| `section_index` | integer | **yes** | `0` for Eligibility, `1` for Main. |
| `section_type` | string | **yes** | `eligibility` or `main`. |
| `name` | string | **yes** | `Eligibility` or `Main` respectively. |
| `description` | string | no | Free text. |

#### `questions` array

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | integer | **yes** | Bundle-local link key. |
| `question_index` | integer | **yes** | 0-based order within the survey. |
| `short_name` | string | **yes** | Variable name for the answer (used in exports and JEXL scripts). Keep it a stable, snake_case identifier. |
| `question_type` | string | **yes** | One of `multiple_choice`, `multi_select`, `numeric`, `text`, `info`. |
| `question_text_json` | JSON-string | **yes** | Multilingual question text. |
| `section_id` | integer | **yes** | The `id` of either the Eligibility or the Main section in this bundle. Screening questions → Eligibility section; everything else → Main section. (The column is technically nullable, but a correct survey assigns every question to a section.) |
| `audio_files_json` | JSON-string | no | Multilingual audio, `{"en":"data:audio/mp3;base64,..."}`. Use `"{}"` or omit when there is no audio. |
| `validation_script` | string (JEXL) | no | Validation expression (mainly for `numeric`/`text`). |
| `validation_error_json` | JSON-string | no | Multilingual message shown when validation fails. |
| `pre_script` | string (JEXL) | no | Skip logic — the question is shown only if this evaluates true. References earlier questions' `short_name`s. |
| `min_selections` | integer / null | no | `multi_select` only — minimum choices. |
| `max_selections` | integer / null | no | `multi_select` only — maximum choices. |
| `skip_to_script` | string (JEXL) | no | Optional jump condition. |
| `skip_to_target` | string | no | `short_name` to jump to when `skip_to_script` is true. |

Type notes for a generator:

- `multiple_choice` — single answer. Provide 2+ `options`.
- `multi_select` — multiple answers. Provide `options`; optionally `min_selections` / `max_selections`.
- `numeric` — number entry. No options. Use `validation_script` (e.g. `value >= 18 && value <= 100`) + `validation_error_json`.
- `text` — free text. No options.
- `info` — informational screen, no answer collected. No options.

#### `options` array

Answer choices for `multiple_choice` / `multi_select` questions only.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `question_id` | integer | **yes** | The `id` of a question in this bundle. |
| `option_index` | integer | **yes** | 0-based order within the question. |
| `option_text_json` | JSON-string | **yes** | Multilingual option label. |
| `option_value` | string | no | Stable code stored when this option is chosen (e.g. `"1"`, `"yes"`). Recommended. |
| `audio_files_json` | JSON-string | no | Multilingual audio; `"{}"` or omit when none. |

#### `survey_messages` array

Multilingual system messages shown at various points in the survey flow.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message_key` | string | **yes** | Identifies where the message is used (see below). |
| `message_text_json` | JSON-string | **yes** | Multilingual message text. |
| `audio_files_json` | JSON-string | no | Multilingual audio; defaults to `"{}"`. |
| `display_order` | integer | no (default 0) | Ordering hint. |
| `message_type` | string | no (default `system`) | e.g. `system`, `instruction`, `confirmation`. |

Known `message_key` values: `eligibility_not_eligible`, `staff_validation`,
`payment_confirmation`, `consent_agreement`, `coupon_instructions`, and
`<testId>_rapid_test_instruction` for rapid-test screens. The importer does
not validate the key; it must be one the tablet build looks for.

#### `test_configurations` array

Which rapid tests are enabled for this survey.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `test_id` | string | **yes** | Identifier of a rapid test the tablet build supports (e.g. `hiv`). Passed through unverified. |
| `test_name` | string | **yes** | Display name. |
| `enabled` | 0 / 1 | no (default 0) | Whether the test is active for this survey. |
| `display_order` | integer | no (default 0) | Ordering. |

### Worked example

A minimal but complete, importable bundle — the required Eligibility and Main
sections, a numeric eligibility/screening question, a `multiple_choice` main
question with options and skip logic, and the not-eligible message:

```json
{
  "schema_version": 1,
  "survey": {
    "name": "Demo Intake Survey",
    "version": 1,
    "description": "Generated from a Word spec",
    "languages": "[\"en\"]",
    "eligibility_script": "age >= 18",
    "eligibility_message_json": "{\"en\":\"You must be 18 or older to participate.\"}",
    "hiv_rapid_test_enabled": 0,
    "fingerprint_enabled": 0
  },
  "sections": [
    {
      "id": 1,
      "section_index": 0,
      "section_type": "eligibility",
      "name": "Eligibility",
      "description": "Screening questions"
    },
    {
      "id": 2,
      "section_index": 1,
      "section_type": "main",
      "name": "Main",
      "description": "Core questions"
    }
  ],
  "questions": [
    {
      "id": 100,
      "section_id": 1,
      "question_index": 0,
      "short_name": "age",
      "question_type": "numeric",
      "question_text_json": "{\"en\":\"What is your age?\"}",
      "validation_script": "value >= 0 && value <= 120",
      "validation_error_json": "{\"en\":\"Enter an age between 0 and 120.\"}"
    },
    {
      "id": 101,
      "section_id": 2,
      "question_index": 1,
      "short_name": "hiv_tested",
      "question_type": "multiple_choice",
      "question_text_json": "{\"en\":\"Have you been tested for HIV in the last 12 months?\"}"
    }
  ],
  "options": [
    { "question_id": 101, "option_index": 0, "option_text_json": "{\"en\":\"Yes\"}", "option_value": "yes" },
    { "question_id": 101, "option_index": 1, "option_text_json": "{\"en\":\"No\"}",  "option_value": "no" }
  ],
  "survey_messages": [
    {
      "message_key": "eligibility_not_eligible",
      "message_text_json": "{\"en\":\"Thank you for your interest. You do not meet the eligibility criteria.\"}",
      "audio_files_json": "{}",
      "message_type": "system"
    }
  ],
  "test_configurations": []
}
```

Notes on the example:

- The survey has the two required sections: Eligibility (`id` 1) and Main (`id` 2).
- The `age` question is in the Eligibility section (`section_id` 1); the survey's `eligibility_script` (`age >= 18`) references its `short_name`.
- The `hiv_tested` question is in the Main section (`section_id` 2); its options' `question_id` (`101`) is that question's bundle-local `id`.
- Section and question `id`s are arbitrary bundle-local integers used only for linking — the importer assigns real database ids.
- The `numeric` question has no options. The `multiple_choice` question has two.
- `eligibility_not_eligible` is the message shown when `eligibility_script` evaluates false.
- `questions` must contain at least one entry; `options`, `survey_messages`, and `test_configurations` may be empty (`test_configurations: []` here), but `sections` must contain the two required sections.
- When a `pre_script` references an option-type answer, it compares against the option's `option_value` (e.g. `"yes"`), not the displayed label.

### Download filename

`salt-survey_<name>_v<version>_<YYYY-MM-DD>.json`, where `<name>` is the
survey name with non-alphanumeric characters replaced by `_` and truncated
to 60 characters.

### Errors

| Status | Condition |
|--------|-----------|
| 400 | `:id` is not an integer |
| 404 | No survey with that id |
| 500 | Unexpected failure |

## Import

Import **always creates a brand-new survey row**. There is no in-place
overwrite or merge — that would require diff logic not worth the risk. To
"update" a survey, import a fresh copy and activate it.

### Request

`POST /api/admin/surveys/import` with the export JSON as the request body
(`Content-Type: application/json`). The server's JSON body limit is 50 MB,
which accommodates audio-heavy surveys.

### Validation

The request is rejected with `400` if:

- The body is not a JSON object.
- `schema_version` does not equal the server's supported version (`1`).
- The `survey` object is missing or has no `name`.
- The bundle contains zero questions.

### Forced fields

Regardless of what the bundle contains, the new survey row is created with:

- `is_active = 0` — imported surveys are inactive; an admin reviews and activates manually.
- `is_draft = 1`.
- `base_survey_id = NULL`, `parent_survey_id = NULL` — dropped to avoid dangling foreign keys across deployments.
- `version` — see below.

All other survey columns are copied from the bundle: `name`, `description`,
`languages`, `eligibility_script`, `eligibility_message_json`,
`version_notes`, `fingerprint_enabled`, `re_enrollment_days`,
`staff_validation_message_json`, `hiv_rapid_test_enabled`,
`contact_info_enabled`, `staff_eligibility_screening`,
`rapid_test_samples_after_eligibility`, `payment_audit_phone_enabled`,
`coupon_count_script`.

### Versioning

If no survey with the same `name` exists on the target, the bundle's
`version` is used as-is. If one or more do exist, the new survey is assigned
`max(existing version) + 1` and a warning is emitted. This guarantees the
import never collides with an existing `(name, version)` pair.

### ID remapping

Auto-increment primary keys differ between deployments, so all internal IDs
are reassigned on insert and intra-bundle references are rewritten:

1. Insert the survey → obtain `newSurveyId`.
2. Insert each section → build `sectionId (old → new)` map.
3. Insert each question with `survey_id = newSurveyId` and `section_id`
   remapped via the section map. A question whose `section_id` is not present
   in the bundle has its section reference dropped (with a warning).
4. Insert each option with `question_id` remapped via the question map.
   Options whose `question_id` is not in the bundle are skipped silently
   (orphan option).
5. Insert each survey message and test configuration with
   `survey_id = newSurveyId`.

### Transactionality

The entire insert sequence runs inside a `BEGIN` / `COMMIT` transaction. Any
failure triggers `ROLLBACK`, so a partial import never leaves a half-built
survey behind.

### Response

On success (`200`):

```json
{
  "status": "success",
  "surveyId": 42,
  "name": "SALT HIV Survey",
  "version": 4,
  "counts": {
    "sections": 2,
    "questions": 6,
    "options": 10,
    "survey_messages": 5,
    "test_configurations": 1
  },
  "warnings": [ "..." ]
}
```

On failure: `400` for validation errors, `500` for an insert failure (after
rollback), each as `{ "status": "error", "message": "..." }`.

### Warnings

`warnings` is a non-fatal advisory list. Possible entries:

- Survey name already existed → imported as the next version.
- Count of rapid test configurations imported, with a reminder to verify the
  `test_id` values match the tablet build's rapid test ids.
- Lab test configurations are global and were not part of the bundle —
  configure them via the Lab Tests admin if needed.
- A question referenced a `section_id` absent from the bundle; the section
  reference was dropped.

## Audit logging

Both operations are recorded via `auditService.logAudit()` (database
`audit_log` table plus the on-disk JSONL backup):

- `EXPORT_SURVEY` — `entity_type = "survey"`, `entity_id` = exported survey id.
- `IMPORT_SURVEY` — `entity_type = "survey"`, `entity_id` = the new survey id.

## UI entry points

- **Survey editor** (`surveyEditorSimple.ejs`) — an "Export Survey" button
  next to the title links directly to the export URL, triggering a download.
- **Surveys list** (`surveys.ejs`) — an "Import Survey" button opens a file
  picker, parses the chosen file as JSON, shows a confirmation dialog (survey
  name + question count), POSTs it to the import endpoint, then redirects to
  the new survey's editor. Any warnings are surfaced in an alert.

## Compatibility

The bundle carries `schema_version`. The import endpoint accepts only an
exact match (`1`). If the bundle format changes in future, bump
`SCHEMA_VERSION` and add handling for older versions as needed. Cross-version
imports fail fast with a clear message rather than importing silently-wrong
data.

## Limitations

- No in-place update — import always creates a new survey.
- Lab test configurations are not transferred (deployment-global).
- Rapid test `test_id` values are passed through unchanged; the importer
  cannot verify they correspond to tests the target tablet build supports.
- The exporting and importing servers must run the same bundle schema
  version.
