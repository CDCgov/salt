---
title: System
description: Server-wide settings, including what a connected AI assistant may do, and signing every AI assistant out.
---

The **System** page (in the navigation bar) holds settings that apply to the whole server.
Only administrators can open it. Changes apply immediately, with no restart, and each change is
recorded in the audit log with who made it and the old and new value.

## AI assistant (MCP)

Administrators can connect their own AI assistant (Claude, ChatGPT) to the server; see
[AI Assistant (MCP)](/management/ai-report-builder/). Two switches control what a connected
assistant can do:

| Switch | Default | What it allows |
|--------|---------|----------------|
| **AI report building** | Off | Reading the data dictionary and aggregate summaries, and creating and rendering reports |
| **AI survey and lab test editing** | On | Creating and editing **inactive** surveys and lab tests. The assistant can never edit or activate the active survey. |

- A change applies from the assistant's next request. Tools for a feature that is off are not
  offered to the assistant, and its instructions don't mention them.
- With **both** switches off, the server refuses AI connections: the assistant gets an error,
  and the sign-in page for connecting a new assistant says AI assistants are turned off.
- Report building is off by default because reports run code against the participant data.
  Turn it on only if your study's data agreements allow the AI service you use to process it.

There is no server configuration file setting for this; the switches on this page are the only
control.

### Connector URL

The page shows the URL to give AI clients (`https://your-server/mcp`). It comes from the
server's `MCP_PUBLIC_URL` setting. If that isn't set, the page shows a URL based on your
browser's address and a warning: AI clients need the server's public HTTPS address.

### Connected sessions

The page shows how many AI assistant sessions are connected. Turning a switch off doesn't sign
anyone out, so **Revoke all sessions** is the immediate way to cut every assistant off. Each
person then has to connect and sign in again. Sessions also end on their own after 6 hours.
