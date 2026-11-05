---
title: Reports
description: Creating, scheduling, and running Quarto-based analytical reports from within the management dashboard.
---

SALT includes a reports engine that runs Quarto documents against the live database. Reports can be run on-demand or scheduled to run automatically.

## Creating a report

Click **Create New Report**:

![Create new report form](../../../assets/screenshots/admin-reports-create.png)

| Field | Description |
|-------|-------------|
| **Report Name** | Display name |
| **Description** | Optional description of what the report covers |
| **Quarto Document** | The R/Quarto source code for the report. A template selector provides starting points. |

The report code does **not** access the SQLite database directly. Instead, the server exports the survey data into the report's working directory before each run, in the same formats produced by the [Export Data](/management/export-data/) tab. The following CSV files are available to read with `read.csv()` / `readr::read_csv()`:

| File | Contents |
|------|----------|
| `data_long.csv` | One row per answer (long format) |
| `data_wide.csv` | One row per completed survey, answer labels as values |
| `data_wide_numeric.csv` | One row per completed survey, option indices as values |

R packages including `RDS`, `tidyverse`, `lubridate`, `scales`, `jsonlite`, and `uuid` are available.

Click **Save & Run** to save and execute immediately, or **Save Report** to save without running.

## Scheduling

Click the **Schedule** icon next to any report:

![Schedule report dialog](../../../assets/screenshots/admin-reports-schedule.png)

| Field | Description |
|-------|-------------|
| **Schedule Type** | `Daily`, `Weekly`, or `Monthly` |
| **Time** | Time of day to run, in UTC (24-hour, e.g. 09:00). The dialog shows the same time in your own time zone below the field. |
| **Day** | Weekly: the day of the week. Monthly: the day of the month; a month without that day (for example the 31st in April) is skipped. |
| **Active** | Toggle on or off without deleting |

Scheduled runs appear in the run history with the type **scheduled**. If the server was off when a run was due, the report runs once when the server is back (or within the hour), rather than once for every run it missed.

## Run history

![Report history showing completed run](../../../assets/screenshots/admin-reports-history.png)

For each run: date, type (manual or scheduled), duration, and download links for PDF / HTML / DOCX output. **View Logs** shows the full Quarto render log.

Completed outputs are stored in `data/reports/runs/` on the server volume.

## R packages available

- `RDS`, Respondent-Driven Sampling estimators
- `tidyverse`, data manipulation and visualisation
- `lubridate`, `scales`, `jsonlite`, `uuid`, utilities
