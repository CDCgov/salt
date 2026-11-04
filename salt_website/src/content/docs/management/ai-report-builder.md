---
title: AI Assistant (MCP)
description: Connect your own AI assistant (Claude) to build reports, and to create and edit surveys and lab tests, using your own subscription.
---

SALT lets an administrator connect their **own AI assistant**, claude.ai
(web), Claude Desktop, or Claude Code, to the SALT server. By chatting, the assistant can build
[Quarto reports](/management/reports/), and create and edit **inactive** surveys and
[lab tests](/management/lab-tests/) (see [Editing surveys and lab tests](#editing-surveys-and-lab-tests)).

For reports, The assistant can read the survey **data dictionary** and **aggregate
summaries**, write the report's R/Quarto, and **render it on the server**, iterating until it
looks right. The finished report appears in **Reports → History** like any other.

It works over the **Model Context Protocol (MCP)**. Your AI subscription powers the work, so
SALT never sees an API key. The assistant receives the survey data dictionary, aggregate
summaries, and the reports you generate. Reports are normally aggregate-only, but anything
included in a report (including any individual-level detail) is shared with the AI service you
connect, so design your reports accordingly.

## Enabling it (administrator / ops)

The feature is **on by default**. The main thing to set is the server's public URL so AI clients
can connect (and to disable it, set `MCP_ENABLED=false`):

```bash
MCP_PUBLIC_URL=https://your-salt-host.example.org   # the public HTTPS URL of this server
# MCP_ENABLED=false                                 # only if you want to turn it off
```

The server must be reachable over **HTTPS at a public URL** so the AI client can connect.
Sessions expire automatically: an access token lasts 30 minutes (refreshed silently) and every
session is **capped at 6 hours**, after which you sign in again.

The management dashboard's **Reports** tab has an **AI Assistant** button that shows your
exact connector URL and these connection steps.

## Connecting from claude.ai

1. In claude.ai, open **Settings → Connectors → Add custom connector**.
2. Enter the connector URL: `https://your-salt-host.example.org/mcp`.
3. Click **Connect**. A SALT sign-in page opens; log in with your administrator account and
   click **Allow**.
4. Start a chat and say **"Help me build a SALT report"** (see below).

## Connecting from ChatGPT

1. In ChatGPT, open **Settings → Connectors** (this requires a plan that supports custom
   connectors / developer mode).
2. Add a connector / MCP server and enter the connector URL: `https://your-salt-host.example.org/mcp`.
3. Authorize by signing in with your SALT administrator account.

## Connecting from Claude Code / Claude Desktop

Claude Code:

```bash
claude mcp add --transport http salt https://your-salt-host.example.org/mcp
```

Run a tool or start a chat; Claude Code opens a browser for the same SALT sign-in. Claude
Desktop uses its **Settings → Connectors** dialog with the same `/mcp` URL.

## Building a report

Once connected, in a new chat just say:

> **Help me build a SALT report**

The assistant takes it from there: it reads the survey's data dictionary and summaries, writes
the report, renders it, and refines it as you describe what you want (for example, *"add HIV
prevalence by age band 18 to 25, 25 to 40, 40+"*). Finished reports appear under
**Reports → History**.

## What the assistant can do

| Capability | Notes |
| --- | --- |
| List surveys, read the data dictionary | One row per export variable (survey, rapid tests, labs) |
| See aggregate summaries | `table()`/`summary()` per variable, never raw rows |
| Read example report templates | The same templates as the Reports editor |
| Create, update, and render reports | Rendered HTML/PDF/DOCX appear in Reports → History |
| Read any survey, check its logic | The same checks as the editor's **Check survey** button |
| Create, copy and edit inactive surveys | Questions, options, skip logic, messages, sections' names, rapid test toggles, audio |
| Create and edit lab tests | Global: active lab tests reach every facility |

The data tools never hand back raw response rows, so the assistant works from aggregates; it
does see the report it builds (its rendered markdown preview), so whatever a report displays is
visible to it. Reports it produces are ordinary reports: you can edit, schedule, and download
them from the [Reports](/management/reports/) tab.

## Editing surveys and lab tests

Say, for example, **"Copy the active survey and add a question about PrEP use after `hivtest`"**,
or **"Build a SALT survey from this questionnaire"** and attach it.

The assistant works on **inactive** surveys only. It can read the active survey, but it can't
change it, because tablets download the active survey at their next login. To change it, the
assistant makes a copy (a new inactive version), edits the copy, and checks it. **A person then
reviews the copy in the [survey editor](/management/surveys/) and activates it.** The assistant
can't activate surveys, and activation is refused while the survey's logic has errors.

What it can change: survey settings and languages, eligibility and coupon count scripts,
questions (text, type, skip logic, validation, skip-to, position, section), options (including
the "other, specify" option), the names of the eligibility and main sections, system messages,
this survey's rapid test toggles, and audio (MP3, up to 10 MB per file). It can also replace a
whole inactive survey from an export bundle, but it is told to use that only for deliberate rewrites.

Every change is checked with the same rules as the editor (reserved and duplicate short names,
"other" options, script syntax and variable names) and recorded in the audit log, marked as made
through MCP.

**Lab tests** are global, so a change to an active lab test reaches every facility's tablets at
their next login; the assistant says so when it makes one. A lab test that already has results
keeps its code, type and options, so existing results stay readable. To change those, the
assistant creates a new test and deactivates the old one. It can't delete lab tests.

The assistant follows a survey authoring guide that explains SALT's survey logic rules. Operators
can edit it at `data/reports/survey-authoring.md` on the server (it is created from the shipped
default on first use).

## Security notes

- Connecting requires an **administrator** login; MCP access grants report, survey and lab test
  capabilities an administrator already has, except that it can't edit or activate the active
  survey and can't delete anything.
- Tokens are stored hashed and can be revoked; every session ends within 6 hours.
- Rendering executes report code on the server, exactly as the existing Reports engine does.
