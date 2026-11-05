# SALT MCP server

Self-contained Model Context Protocol (MCP) server that lets an administrator's own AI
assistant (claude.ai, Claude Code, Claude Desktop) work with this SALT instance using their AI
subscription: build and render Quarto reports, and create and edit inactive surveys and lab
tests. No participant rows leave the server.

Everything lives under `src/mcp/` and is always mounted. What it offers is controlled at runtime
by two switches on the System page (`/admin/system`, stored by `src/services/systemSettings.js`):
`mcp_reports_enabled` (report tools, default **off**) and `mcp_survey_editing_enabled` (survey and
lab test tools, default **on**). There is no environment variable for this.

- Each request (`server.js`) reads the switches and registers only the groups that are on
  (`toolGroups.js`); the advertised instructions name only those groups. `list_surveys` is shared
  and offered when either is on. Each tool also re-checks its switch when called.
- With both off, `/mcp` answers every request with a JSON-RPC error (HTTP 403) and the consent
  page (`/mcp-consent`) refuses to connect new clients.
- Switching off doesn't revoke tokens; the System page's **Revoke all sessions** does
  (`sessionStore.revokeAllSessions()`).

## Layout

| File | Responsibility |
| --- | --- |
| `index.js` | `init(app)`: mounts the server |
| `toolGroups.js` | Registers each tool group only when its System page switch is on; call-time re-check |
| `server.js` | `mountMcp(app)`: Streamable HTTP MCP endpoint at `/mcp` (stateless), bearer auth |
| `tools.js` | The report tools (wrap existing services); profile cache + render rate-limit; registers `surveyTools.js` |
| `surveyTools.js` | The survey and lab test tools (wrap `surveyEditing`, `labTestEditing`, `surveyBundle`, `jexlCheck`) |
| `survey-authoring.default.md` | Shipped default of the editable survey authoring guide |
| `oauth.js` | OAuth 2.1 authorization server (Path B) via the SDK's `mcpAuthRouter` + a consent page |
| `sessionStore.js` | Token issue/verify/refresh/revoke in `mcp_sessions`; enforces the 6h absolute cap |

Shared services it builds on (reusable elsewhere, not MCP-specific):
`src/services/dataDictionary.js`, `src/services/dataProfiler.js`,
`src/services/reportInstructions.js`, and for surveys `src/services/surveyEditing.js`,
`src/services/labTestEditing.js`, `src/services/surveyBundle.js`, `src/services/surveyAuthoringGuide.js`
(the web survey editor and lab test routes call the same services). Rendering reuses `src/services/reportExecutor.js`
(extended with an optional `{runId, markdown}` arg) and the existing `reports` /
`report_runs` / `report_outputs` tables.

The MCP SDK is ESM; this is a CommonJS codebase, so the SDK is loaded via dynamic `import()`.

## Environment

| Var | Default | Meaning |
| --- | --- | --- |
| `MCP_PUBLIC_URL` | `http://localhost:$PORT` | Public HTTPS base URL (OAuth issuer + resource id) |
| `MCP_ACCESS_TTL_SECONDS` | `1800` | Access-token lifetime |
| `MCP_SESSION_MAX_SECONDS` | `21600` | Absolute session cap (6h); refresh refused past it |
| `MCP_INSTRUCTIONS_FILE` | `data/reports/report-instructions.md` | Editable report-generation prompt (see below) |
| `MCP_SURVEY_GUIDE_FILE` | `data/reports/survey-authoring.md` | Editable survey authoring guide (seeded from `survey-authoring.default.md`) |
| `MCP_TEMPLATES_DIR` | `data/reports/templates` | Example templates dir; seeded from `src/mcp/templates-default/` on first run (the data volume is dockerignored, so shipped defaults are copied in) |
| `MCP_MAX_MD_CHARS` / `MCP_MAX_LOG_CHARS` / `MCP_PROFILE_CHAR_CAP` | 5M / 1M / 2M | Very large backstop truncation limits for tool payloads |

## Editing the report instructions

The system prompt the AI receives is an **editable Markdown file**. The shipped default lives at
`src/mcp/report-instructions.default.md`; on first run it is copied to
`data/reports/report-instructions.md` (in the persistent data volume) and read from there.
Edit that file to tune the guidance — changes take effect on the next read (no restart needed).
The `{{SURVEY}}` token is replaced per request with the survey context. Set `MCP_INSTRUCTIONS_FILE`
to use a different path. Delete the file to re-seed the default.

## Database

`scripts/add-mcp.sql` (idempotent) creates `oauth_clients`, `oauth_auth_codes`,
`mcp_sessions`. The same tables are in `scripts/init-database.js` for fresh DBs.

```bash
sqlite3 data/database/salt.db < scripts/add-mcp.sql
```

## Auth model

- **claude.ai / Claude Code / Claude Desktop**: OAuth 2.1 with dynamic client registration and
  PKCE. `/authorize` reuses the existing SALT session login through an MCP-owned consent page
  (`/mcp-consent`), then issues a one-time code. Tokens come from `sessionStore`.
- **Local dev / static-header clients**: mint a token directly:
  ```bash
  node scripts/mcp-mint-token.js [username]   # default: first administrator
  ```
  Use it as `Authorization: Bearer <token>` (e.g. `claude mcp add --header ...`).

Sessions: short access token (silently refreshed) with an absolute 6-hour cap; `revoked`
supports instant logout. Only the `administrator` role may call tools; mutations are audited.

The MCP server identifies itself as `salt`. Its advertised instructions tell the AI to call
`get_report_instructions` before report work and `get_survey_authoring_guide` before survey or lab
test work.

## Tools

`list_surveys`, `get_data_dictionary`, `get_data_profile`, `get_variable_summary`,
`list_templates`, `get_template`, `get_report_instructions`, `list_reports`, `get_report`,
`save_report`, `update_report`, `edit_report`, `render_report`, `get_render_result`.

**`edit_report` is highly preferred for all updates to an existing report.** It applies a
targeted exact-string replacement (like an editor's find/replace, no staleness guard): rejects
unless `old_string` matches once (or `replace_all`), persists the change atomically, and returns
a unified diff. Edits should be **as targeted as possible** so unrelated parts of the report are
never overwritten. `update_report` is a full-document rewrite and should be used only for a
deliberate wholesale rewrite.

No tool returns row-level data. `render_report` is async (returns a `runId`); poll
`get_render_result` until `success`/`error`. On success it returns a capped markdown preview of
the rendered report (the report itself, with HTML/PDF/DOCX, lands in Reports → History).

### Survey and lab test tools

Read (any survey): `get_survey_authoring_guide`, `get_survey` (export-bundle format; audio replaced
by per-language flags unless `include_audio`), `check_survey` (item 1's JEXL check plus an audio
summary), `list_lab_tests`, `get_lab_test`.

Write: `create_survey`, `copy_survey`, `replace_survey` (needs `expected_updated_at`),
`update_survey_settings` (including this survey's rapid test toggles), `add_question`,
`update_question`, `delete_question`, `move_question`, `set_options`, `update_section`,
`set_message`, `set_audio`, `remove_audio`, `create_lab_test`, `update_lab_test`,
`deactivate_lab_test`, `reactivate_lab_test`.

Rules:
- Survey writes refuse a survey with `is_active = 1`. The AI copies the live survey, edits the copy,
  and a person activates it in the web UI. There is no activation tool, and no delete tools for
  surveys or lab tests.
- Every survey write bumps `surveys.updated_at` (millisecond precision) and returns the JEXL check
  for what it touched. Errors don't block a draft save; activation is blocked until they're fixed.
- Sections can only be renamed: tablets support exactly the `eligibility` and `main` sections, and
  `create_survey` / `replace_survey` refuse bundles without both.
- Lab tests are global; changes to active tests say so. A test with results can't change its
  code or type or lose options.
- Audio: base64 MP3 (ID3 tag or frame header), at most 10 MB decoded, one file per call, in one
  of the survey's languages.
- Every write is audited with `via: 'mcp'`.

## Tests

`npm run test:integration` (alias `test:mcp`; `scripts/run-mcp-tests.sh`) starts a server on a
throwaway copy of the database and runs `scripts/test-mcp.mjs` (reports, OAuth),
`scripts/test-mcp-survey.mjs` (survey and lab test tools), `scripts/test-mcp-settings.mjs`
(System page switches), `scripts/test-other-specify.mjs` and `scripts/test-survey-copy.mjs`.
`npm run test:browser` runs `scripts/test-browser.mjs` in Chrome through Playwright.

## Discovery endpoints (when enabled)

- `/.well-known/oauth-authorization-server`
- `/.well-known/oauth-protected-resource/mcp`
- `/authorize`, `/token`, `/register`, `/revoke`, `/mcp`

## Known dependency

Render sandboxing is intentionally **not** included here: rendering executes report code on the
server exactly as the existing Reports engine already does. Hardening report execution (for all
run paths, not just MCP) is tracked as a separate feature.
