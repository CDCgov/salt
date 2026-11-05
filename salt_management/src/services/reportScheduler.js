const cron = require('node-cron');
const { allAsync, runAsync } = require('../models/database');
const ReportExecutor = require('./reportExecutor');

class ReportScheduler {
    constructor() {
        this.jobs = new Map();
        this.reportExecutor = new ReportExecutor();
    }

    /**
     * Initialize the scheduler and load all active schedules
     */
    async initialize() {
        console.log('Initializing report scheduler...');

        try {
            // Load all active schedules from database
            const schedules = await this.getActiveSchedules();

            // Create cron jobs for each schedule
            for (const schedule of schedules) {
                this.createJob(schedule);
            }

            console.log(`Loaded ${schedules.length} scheduled reports`);

            // Check for missed runs every hour
            cron.schedule('0 * * * *', () => {
                this.checkMissedRuns();
            });

        } catch (error) {
            console.error('Failed to initialize report scheduler:', error);
        }
    }

    /**
     * Get all active schedules from database
     */
    async getActiveSchedules() {
        return await allAsync(`
            SELECT
                rs.*,
                r.name as report_name
            FROM report_schedules rs
            JOIN reports r ON rs.report_id = r.id
            WHERE rs.is_active = 1 AND r.is_active = 1
        `);
    }

    /**
     * Create a cron job for a schedule
     */
    createJob(schedule) {
        const cronPattern = this.buildCronPattern(schedule);

        if (!cron.validate(cronPattern)) {
            console.error(`Invalid cron pattern for schedule ${schedule.id}: ${cronPattern}`);
            return;
        }

        const job = cron.schedule(cronPattern, async () => {
            await this.executeScheduledReport(schedule);
        }, {
            timezone: 'UTC'
        });

        this.jobs.set(schedule.id, job);
        console.log(`Created cron job for report ${schedule.report_name} (${schedule.report_id}) with pattern: ${cronPattern}`);
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
                // Run monthly on specified day (1-31)
                return `${minute} ${hour} ${schedule.schedule_day} * *`;

            default:
                throw new Error(`Invalid schedule type: ${schedule.schedule_type}`);
        }
    }

    /**
     * Execute a scheduled report
     */
    async executeScheduledReport(schedule) {
        console.log(`Executing scheduled report: ${schedule.report_name} (${schedule.report_id})`);

        try {
            // Execute the report
            const runId = await this.reportExecutor.executeReport(
                schedule.report_id,
                'scheduled'
            );

            // Update last run and calculate next run
            await this.updateScheduleAfterRun(schedule.id);

            console.log(`Scheduled report completed: ${schedule.report_name}, Run ID: ${runId}`);

        } catch (error) {
            console.error(`Failed to execute scheduled report ${schedule.report_id}:`, error);
        }
    }

    /**
     * Update schedule after successful run
     */
    async updateScheduleAfterRun(scheduleId) {
        const now = new Date();

        // Get the schedule details
        const schedule = await allAsync(
            'SELECT * FROM report_schedules WHERE id = ?',
            [scheduleId]
        );

        if (schedule.length > 0) {
            const nextRun = this.calculateNextRun(
                schedule[0].schedule_type,
                schedule[0].schedule_time,
                schedule[0].schedule_day
            );

            await runAsync(
                `UPDATE report_schedules
                 SET last_run = ?, next_run = ?
                 WHERE id = ?`,
                [now.toISOString(), nextRun, scheduleId]
            );
        }
    }

    /**
     * Calculate next run time based on schedule
     */
    calculateNextRun(type, time, day) {
        const now = new Date();
        const [hour, minute] = time.split(':').map(Number);
        const next = new Date();
        next.setUTCHours(hour, minute, 0, 0);

        switch (type) {
            case 'daily':
                if (next <= now) {
                    next.setUTCDate(next.getUTCDate() + 1);
                }
                break;

            case 'weekly':
                const targetDay = parseInt(day);
                const currentDay = next.getUTCDay();
                const daysUntilTarget = (targetDay - currentDay + 7) % 7;
                next.setUTCDate(next.getUTCDate() + daysUntilTarget);
                if (next <= now) {
                    next.setUTCDate(next.getUTCDate() + 7);
                }
                break;

            case 'monthly':
                next.setUTCDate(parseInt(day));
                if (next <= now) {
                    next.setUTCMonth(next.getUTCMonth() + 1);
                }
                break;
        }

        return next.toISOString();
    }

    /**
     * Check for missed runs and execute them
     */
    async checkMissedRuns() {
        const now = new Date();

        const missedSchedules = await allAsync(`
            SELECT
                rs.*,
                r.name as report_name
            FROM report_schedules rs
            JOIN reports r ON rs.report_id = r.id
            WHERE rs.is_active = 1
              AND r.is_active = 1
              AND datetime(rs.next_run) < datetime('now')
              AND (rs.last_run IS NULL OR datetime(rs.last_run) < datetime(rs.next_run))
        `);

        for (const schedule of missedSchedules) {
            console.log(`Found missed run for report ${schedule.report_name}`);
            await this.executeScheduledReport(schedule);
        }
    }

    /**
     * Add or update a schedule
     */
    async addOrUpdateSchedule(reportId, scheduleConfig) {
        // Remove existing job if any
        const existingSchedule = await allAsync(
            'SELECT id FROM report_schedules WHERE report_id = ?',
            [reportId]
        );

        if (existingSchedule.length > 0) {
            this.removeJob(existingSchedule[0].id);
        }

        // Create new schedule in database (handled by API)
        // Then reload the schedule
        const newSchedule = await allAsync(`
            SELECT
                rs.*,
                r.name as report_name
            FROM report_schedules rs
            JOIN reports r ON rs.report_id = r.id
            WHERE rs.report_id = ? AND rs.is_active = 1`,
            [reportId]
        );

        if (newSchedule.length > 0) {
            this.createJob(newSchedule[0]);
        }
    }

    /**
     * Remove a scheduled job
     */
    removeJob(scheduleId) {
        const job = this.jobs.get(scheduleId);
        if (job) {
            job.destroy();
            this.jobs.delete(scheduleId);
            console.log(`Removed scheduled job: ${scheduleId}`);
        }
    }

    /**
     * Stop all scheduled jobs
     */
    stopAll() {
        for (const [scheduleId, job] of this.jobs) {
            job.destroy();
        }
        this.jobs.clear();
        console.log('All scheduled jobs stopped');
    }
}

// Create singleton instance
const reportScheduler = new ReportScheduler();

module.exports = reportScheduler;