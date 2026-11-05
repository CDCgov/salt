const cron = require('node-cron');
const { allAsync, getAsync, runAsync } = require('../models/database');
const ReportExecutor = require('./reportExecutor');

// Schedule times are UTC. A missed run is only caught up once it is this
// late, so the hourly check never races the job's own on-time run.
const MISSED_RUN_GRACE_MINUTES = 5;

const ACTIVE_SCHEDULE_SQL = `
    SELECT
        rs.*,
        r.name as report_name
    FROM report_schedules rs
    JOIN reports r ON rs.report_id = r.id
    WHERE rs.is_active = 1 AND r.is_active = 1`;

class ReportScheduler {
    constructor() {
        this.jobs = new Map();      // report_id -> cron task (one schedule per report)
        this.running = new Set();   // schedule ids with a run in progress
        this.missedRunCheck = null;
        this.reportExecutor = new ReportExecutor();
    }

    /**
     * Initialize the scheduler: load all active schedules, catch up any run
     * missed while the server was down, then check for missed runs hourly.
     */
    async initialize() {
        if (this.missedRunCheck) return;
        console.log('Initializing report scheduler...');

        try {
            const schedules = await allAsync(ACTIVE_SCHEDULE_SQL);

            // Missed runs are found from the stored next_run, so look before
            // createJob overwrites it with the next future time.
            const missed = await this.findMissedRuns();

            for (const schedule of schedules) {
                await this.createJob(schedule);
            }

            console.log(`Loaded ${schedules.length} scheduled reports`);

            this.missedRunCheck = cron.schedule('30 * * * *', () => {
                this.checkMissedRuns();
            }, { timezone: 'UTC' });

            this.runMissed(missed);

        } catch (error) {
            console.error('Failed to initialize report scheduler:', error);
        }
    }

    /**
     * Create the cron job for a schedule and store its next run time.
     */
    async createJob(schedule) {
        this.removeJob(schedule.report_id);

        const cronPattern = this.buildCronPattern(schedule);

        if (!cron.validate(cronPattern)) {
            console.error(`Invalid cron pattern for schedule ${schedule.id}: ${cronPattern}`);
            return null;
        }

        const job = cron.schedule(cronPattern, async () => {
            await this.executeScheduledReport(schedule);
        }, {
            timezone: 'UTC'
        });

        this.jobs.set(schedule.report_id, job);
        console.log(`Created cron job for report ${schedule.report_name} (${schedule.report_id}) with pattern: ${cronPattern}`);

        const nextRun = this.nextRunOf(schedule.report_id);
        await runAsync('UPDATE report_schedules SET next_run = ? WHERE id = ?', [nextRun, schedule.id]);
        return nextRun;
    }

    /**
     * Build cron pattern from schedule configuration
     */
    buildCronPattern(schedule) {
        const [hour, minute] = schedule.schedule_time.split(':').map(Number);

        switch (schedule.schedule_type) {
            case 'daily':
                // Run daily at specified time
                return `${minute} ${hour} * * *`;

            case 'weekly':
                // Run weekly on specified day (0-6, Sunday is 0)
                return `${minute} ${hour} * * ${schedule.schedule_day}`;

            case 'monthly':
                // Run monthly on specified day (1-31); months without that day are skipped
                return `${minute} ${hour} ${schedule.schedule_day} * *`;

            default:
                throw new Error(`Invalid schedule type: ${schedule.schedule_type}`);
        }
    }

    /**
     * Next run time (ISO string) of a report's job, or null if it has none.
     */
    nextRunOf(reportId) {
        const job = this.jobs.get(reportId);
        const next = job && job.getNextRun();
        return next ? next.toISOString() : null;
    }

    /**
     * Execute a scheduled report
     */
    async executeScheduledReport(schedule) {
        if (this.running.has(schedule.id)) {
            console.log(`Scheduled report ${schedule.report_name} is already running; skipping`);
            return;
        }
        this.running.add(schedule.id);
        console.log(`Executing scheduled report: ${schedule.report_name} (${schedule.report_id})`);

        try {
            // Record the run before starting, so neither the missed-run check
            // nor a restart repeats it while Quarto is still rendering.
            await runAsync(
                'UPDATE report_schedules SET last_run = ?, next_run = ? WHERE id = ?',
                [new Date().toISOString(), this.nextRunOf(schedule.report_id), schedule.id]
            );

            const runId = await this.reportExecutor.executeReport(
                schedule.report_id,
                'scheduled'
            );

            console.log(`Scheduled report completed: ${schedule.report_name}, Run ID: ${runId}`);

        } catch (error) {
            console.error(`Failed to execute scheduled report ${schedule.report_id}:`, error);
        } finally {
            this.running.delete(schedule.id);
        }
    }

    /**
     * Run any active schedule whose next run passed without running (for
     * example because the server was down). Each schedule is caught up once.
     */
    async checkMissedRuns() {
        try {
            await this.runMissed(await this.findMissedRuns());
        } catch (error) {
            console.error('Failed to check for missed report runs:', error);
        }
    }

    findMissedRuns() {
        return allAsync(`${ACTIVE_SCHEDULE_SQL}
              AND rs.next_run IS NOT NULL
              AND datetime(rs.next_run) < datetime('now', '-${MISSED_RUN_GRACE_MINUTES} minutes')
              AND (rs.last_run IS NULL OR datetime(rs.last_run) < datetime(rs.next_run))
        `);
    }

    async runMissed(missedSchedules) {
        for (const schedule of missedSchedules) {
            console.log(`Found missed run for report ${schedule.report_name}`);
            await this.executeScheduledReport(schedule);
        }
    }

    /**
     * Bring a report's job in line with the database after its schedule or
     * the report itself changed. Returns the next run time, or null when the
     * report has no active schedule.
     */
    async syncReport(reportId) {
        reportId = Number(reportId);
        this.removeJob(reportId);

        const schedule = await getAsync(`${ACTIVE_SCHEDULE_SQL} AND rs.report_id = ?`, [reportId]);
        if (schedule) {
            return await this.createJob(schedule);
        }

        await runAsync('UPDATE report_schedules SET next_run = NULL WHERE report_id = ?', [reportId]);
        return null;
    }

    /**
     * Remove a report's scheduled job
     */
    removeJob(reportId) {
        const job = this.jobs.get(reportId);
        if (job) {
            job.destroy();
            this.jobs.delete(reportId);
            console.log(`Removed scheduled job for report ${reportId}`);
        }
    }

    /**
     * Stop all scheduled jobs
     */
    stopAll() {
        for (const job of this.jobs.values()) {
            job.destroy();
        }
        this.jobs.clear();
        if (this.missedRunCheck) {
            this.missedRunCheck.destroy();
            this.missedRunCheck = null;
        }
        console.log('All scheduled jobs stopped');
    }
}

// Create singleton instance
const reportScheduler = new ReportScheduler();

module.exports = reportScheduler;
