/**
 * dataProfiler.js — generates aggregate per-variable frequencies/summaries as a
 * plain-text "profile" for a survey, using R.
 *
 * Strategy (per the MCP plan): export the analysis CSVs, then run an R script
 * that, for each variable, prints `table()` when it has <= 20 distinct values
 * and `summary()` otherwise. Free-text questions are never enumerated (only a
 * count + distinct count) to avoid leaking PII.
 *
 * Only aggregate counts / quantiles ever leave R — never row values. Decoupled
 * from MCP; reusable anywhere an aggregate snapshot of a survey is useful.
 */

const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const uuid = require('uuid');
const { buildDictionaryRows } = require('./dataDictionary');
const { childProcessEnv } = require('./childProcessEnv');

const MAX_LEVELS = 20;               // table() at/below this many distinct values, else summary()
// Very large backstop on profile text (not a content limit). Override via env.
const DEFAULT_CHAR_CAP = parseInt(process.env.MCP_PROFILE_CHAR_CAP || '2000000', 10);

class DataProfiler {
    constructor() {
        this.tempRoot = path.join(process.cwd(), 'data', 'reports', 'temp');
    }

    /**
     * Generate the aggregate profile text for a survey.
     * @param {number} surveyId
     * @param {{charCap?: number}} [options]
     * @returns {Promise<string>} profile text (table()/summary() per variable)
     */
    async generateProfile(surveyId, options = {}) {
        const charCap = options.charCap || DEFAULT_CHAR_CAP;
        const workDir = path.join(this.tempRoot, `profile-${uuid.v4()}`);
        await fs.mkdir(workDir, { recursive: true });

        try {
            // Classify variables from the dictionary so we know which are text
            // (suppress) vs numeric (summary on numeric file) vs categorical.
            const { survey, rows } = await buildDictionaryRows(surveyId);
            const textVars = rows.filter(r => r.type === 'text').map(r => r.variable);
            const numericVars = rows.filter(r => r.type === 'numeric').map(r => r.variable);

            // Export the analysis CSVs (reuse the existing exporter).
            await this._exportData(workDir);

            // Write the classification + R script and run it.
            await fs.writeFile(path.join(workDir, 'text_vars.txt'), textVars.join('\n'), 'utf8');
            await fs.writeFile(path.join(workDir, 'numeric_vars.txt'), numericVars.join('\n'), 'utf8');
            await fs.writeFile(path.join(workDir, 'profile.R'), this._rScript(MAX_LEVELS), 'utf8');

            const output = await this._runR(workDir);

            const header = `# Data profile — survey: ${survey.name} (id ${survey.id}, version ${survey.version})\n` +
                `# table() shown for variables with <= ${MAX_LEVELS} distinct values; summary() otherwise.\n` +
                `# Free-text variables are summarised (count + distinct) without listing values.\n\n`;
            let text = header + output;

            if (text.length > charCap) {
                text = text.slice(0, charCap) + `\n\n[... profile truncated at ${charCap} characters ...]\n`;
            }
            return text;
        } finally {
            await this._cleanup(workDir);
        }
    }

    async _exportData(workDir) {
        const DataExporter = require('./dataExporter');
        const exporter = new DataExporter();
        const longData = await exporter.exportLongFormat();
        await fs.writeFile(path.join(workDir, 'data_long.csv'), longData, 'utf8');
        const wideText = await exporter.exportWideFormat('text');
        await fs.writeFile(path.join(workDir, 'data_wide.csv'), wideText, 'utf8');
        const wideNumeric = await exporter.exportWideFormat('numeric');
        await fs.writeFile(path.join(workDir, 'data_wide_numeric.csv'), wideNumeric, 'utf8');
    }

    _rScript(maxLevels) {
        return `# Auto-generated aggregate profiler. Aggregates only — never prints rows.
options(width = 100)
wide <- tryCatch(read.csv("data_wide.csv", stringsAsFactors = FALSE, check.names = FALSE),
                 error = function(e) data.frame())
wnum <- tryCatch(read.csv("data_wide_numeric.csv", stringsAsFactors = FALSE, check.names = FALSE),
                 error = function(e) data.frame())
textVars <- tryCatch(readLines("text_vars.txt", warn = FALSE), error = function(e) character(0))
numVars  <- tryCatch(readLines("numeric_vars.txt", warn = FALSE), error = function(e) character(0))
textVars <- textVars[nzchar(textVars)]
numVars  <- numVars[nzchar(numVars)]

cat("Total records:", nrow(wide), "\\n\\n")

maxLevels <- ${maxLevels}
skipCols <- c("survey_id", "participant_id", "meta_survey_id", "meta_participant_id",
              "meta_facility_id", "device_id")

for (col in names(wide)) {
  if (col %in% skipCols) next
  x <- wide[[col]]
  x[x == ""] <- NA
  n <- length(x); nmiss <- sum(is.na(x)); nval <- n - nmiss
  cat("== ", col, " ==\\n", sep = "")
  cat("n = ", nval, ", missing = ", nmiss, "\\n", sep = "")

  if (col %in% textVars) {
    cat("(free text — values suppressed) distinct = ", length(unique(x[!is.na(x)])), "\\n\\n", sep = "")
    next
  }
  if (col %in% numVars && !is.null(wnum[[col]])) {
    v <- suppressWarnings(as.numeric(wnum[[col]]))
    print(summary(v))
    cat("\\n")
    next
  }
  ndist <- length(unique(x[!is.na(x)]))
  if (ndist <= maxLevels) {
    print(table(x, useNA = "always"))
  } else {
    cat("(", ndist, " distinct values) ", sep = "")
    v <- suppressWarnings(as.numeric(x))
    if (sum(!is.na(v)) >= 0.8 * nval) { print(summary(v)) } else {
      cat("top values:\\n"); print(head(sort(table(x), decreasing = TRUE), maxLevels))
    }
  }
  cat("\\n")
}
`;
    }

    _runR(workDir) {
        return new Promise((resolve) => {
            exec('Rscript profile.R', {
                cwd: workDir,
                timeout: 600000,                 // 10 min backstop
                maxBuffer: 16 * 1024 * 1024,
                // Same reduced environment as report rendering (see childProcessEnv.js).
                env: childProcessEnv({ LANG: 'en_US.UTF-8' }),
            }, (error, stdout, stderr) => {
                let out = stdout || '';
                if (error && !out) out = `# Profiler error\n${stderr || error.message}\n`;
                else if (stderr) out += `\n# R warnings:\n${stderr}\n`;
                resolve(out);
            });
        });
    }

    async _cleanup(dir) {
        try {
            await fs.rm(dir, { recursive: true, force: true });
        } catch (e) {
            console.error('DataProfiler cleanup error:', e.message);
        }
    }
}

module.exports = DataProfiler;
