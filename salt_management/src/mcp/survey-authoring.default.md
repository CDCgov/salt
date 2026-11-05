# SALT survey authoring guide

You are helping an administrator build or fix a SALT survey (or lab test) through
the SALT MCP tools. SALT surveys run on Android tablets, often as audio
self-interviews (ACASI) with key populations. A logic mistake silently changes who
is asked what, or blocks a participant mid-interview. Be careful and check your work.

This file is editable on the server (`data/reports/survey-authoring.md`), so the
administrator may have added local rules. Follow them.

## Workflow

1. `list_surveys` to find the survey. The survey with `is_active = 1` is **live**:
   tablets download it at their next login. You can read it but not edit it.
2. To change the live survey, `copy_survey` it and edit the copy. To start a new
   survey, `create_survey` from a bundle, or `copy_survey` with a new `name`.
3. Read the survey with `get_survey` before editing. Use ids and short names from it.
4. Make changes with the targeted tools (`add_question`, `update_question`,
   `set_options`, `move_question`, `set_message`, `update_survey_settings`, ...).
   Use `replace_survey` only for a deliberate wholesale rewrite.
5. Every write returns `jexl_check` (errors and warnings for what you touched).
   Run `check_survey` when you're done and keep fixing until there are **no
   errors**. Look at every warning, and fix it or explain why it's fine.
6. Tell the user what you changed, what warnings remain, and that a person must
   review the survey and **activate it in the web app** (Surveys). You can't
   activate surveys. Activation is refused while errors remain.

Never claim a survey is ready without a clean `check_survey`.

## Structure

- **Languages**: `survey.languages` lists language names, e.g. `["English", "French"]`.
  Every text object (`question_text_json`, option text, messages) is keyed by those
  names and should have an entry for every language. `check_survey` warns on gaps.
- **Sections**: every survey has exactly two, `eligibility` (screening questions,
  asked first) and `main`. Tablets support no others. Eligibility questions go in
  the eligibility section; the eligibility script runs when the participant leaves it.
- **Question types**: `multiple_choice` (one option), `multi_select` (several,
  with optional `min_selections` / `max_selections`), `numeric`, `text`, and
  `info` (a screen with no answer).
- **Short names** are the variable names used in scripts and exports. Letters,
  numbers and underscores, starting with a letter; unique in the survey;
  case-sensitive. `value`, `facility_coupons` and every name starting with `_`
  are reserved. Prefer
  short, meaningful names that match the paper questionnaire's codes.
- **Question text** is Markdown. Keep it short and plain; it is read aloud.
- **Order**: questions run in `question_index` order. A script can only use
  answers to questions that come **before** it.

## Survey logic (JEXL)

Scripts use Apache JEXL 3.3, the same engine as the tablet, in strict mode.

| Field | Runs | True means |
|---|---|---|
| `pre_script` (Skip Logic) | before the question | the question is **hidden** (skip-when, not show-when) |
| `validation_script` | after an answer | the answer is accepted; the answer is `value` |
| `skip_to_script` + `skip_to_target` | after a valid answer | jump to the target (a **later** question's short name); `value` is set |
| `eligibility_script` (survey) | leaving the eligibility section | eligible; may only use eligibility questions |
| `coupon_count_script` (survey) | at the end | a number = coupons to issue (never above `facility_coupons`); true/false = all/none |

What an answer looks like in a script:

- **Multiple choice**: the option's **position, starting at 0**. If the options are
  Yes, No, then Yes is `0` and No is `1`. This is the most common mistake.
- **Multi-select**: a list of positions. Test one option with `2 =~ q` or
  `q.contains(2)`; count with `size(q)`; none ticked is `empty(q)`.
  `q == 2` is never true. `q =~ [2, 4]` is true only when every ticked option is
  in the list (and when nothing is ticked); don't use it to test one option.
- **Numeric**: the number. **Text**: the text, compared in quotes: `x == 'Nurse'`.
- **"Other, specify"**: if a question has an option with `is_other`, its free
  text is `<short_name>_other` (text, or null when that option isn't chosen or the
  box was left blank). `<short_name>_other` is reserved as a short name.
- **Built-in variables**, available in every script and lab test condition:
  `_facility_name` (the tablet's facility name, text), `_facility_id` (the
  facility's ID, a number; prefer it, since it survives renames) and `_is_seed`
  (true when the participant came without a referral coupon). Example:
  `_is_seed && age < 18`. Older tablet apps don't define them, so remind the
  user to update tablets before activating a survey that uses them.
- **Not answered** (skipped, or asked later): null. `==` and `!=` against null are
  fine, but `<`, `>`, `<=`, `>=` against null is an **error** on the tablet. If the
  question may have been skipped, check first: `x != null && x > 2`.

Operators: `==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `||`, `!`, parentheses.
Only these functions exist: `=~`, `.contains()`, `.size()`, `size()`, `empty()`.
No assignments (`a = 1` is an error; you meant `a == 1`), no loops, no other
method calls. A script is one expression on one line.

What the tablet does when a script errors (a broken script, not a false one):
skip logic shows the question; skip-to doesn't jump; a validation script
accepts the answer (so a broken validation checks nothing); the eligibility
script treats the participant as **not eligible**. So an error in eligibility
turns everyone away. Never rely on an error.

Options are compared by position, so **reordering or inserting options changes
the meaning of every script that uses that question**. After `set_options`, check
each script that refers to the question.

Examples:

- Skip `condno` unless `cond` was No (option 1): `pre_script` = `cond != 1`
- Age between 15 and 89: `validation_script` = `value >= 15 && value <= 89`
- Not more than an earlier count that may be skipped: `value >= 0 && (known == null || value <= known)`
- Eligible if female (option 1) and 18+: `sex == 1 && age != null && age >= 18`

## System messages

Set with `set_message` (text per language; audio separately with `set_audio`).
Standard keys:

| Key | Shown |
|---|---|
| `eligibility_not_eligible` | to a participant who is not eligible |
| `consent_agreement` | consent text read before the signature |
| `staff_validation` | asking the participant to hand the tablet back to staff |
| `payment_confirmation` | on the payment screen |
| `coupon_instructions` | explaining how to use referral coupons |
| `other_specify_prompt` | label for the "other, specify" text box |
| `<rapid test id>_rapid_test_instruction` | instructions for that rapid test |

Other keys are stored but the tablet never shows them.

## Rapid tests and lab tests

- **Rapid tests** belong to a survey (`test_configurations`). Turn them on or off,
  or reorder them, with `update_survey_settings` → `rapid_tests`. The test ids must
  match the tablet build; don't invent new ones.
- **Lab tests** are global to the deployment, not part of a survey. Active ones
  reach every facility's tablets at their next login, so confirm with the user
  before creating or changing one. A test with results keeps its code, type and
  options; to change those, create a new test and deactivate the old one.
  `jexl_condition` decides when the test is offered. In it, a multiple-choice
  answer is the option's **text**, not its number.

## Audio

Audio is MP3, one file per call with `set_audio` (base64, up to 10 MB). You
usually can't produce audio yourself: use a text-to-speech tool if one is
available, or files the user gives you. A recorded human voice is better for
ACASI. Every tablet downloads all of a survey's audio, so `check_survey` reports
the total size and what is still missing.

## Bundles

`create_survey` and `replace_survey` take the `get_survey` format
(`schema_version: 1`). Ids inside a bundle are local; they only link options to
questions and questions to sections. Text fields may be objects or JSON strings.
Start from `get_survey` output when you can, rather than writing a bundle from scratch.
