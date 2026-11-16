// Long-running scheduler. Never runs two backup jobs at the same time.

import cron from 'node-cron';

/** Wrap a job so overlapping invocations are skipped instead of stacked. */
export function nonOverlapping(job, { logger } = {}) {
  let running = null;
  const wrapped = async () => {
    if (running) {
      logger?.warn('previous backup run still in progress; skipping this tick');
      return { skipped: true };
    }
    running = (async () => job())();
    try {
      return await running;
    } finally {
      running = null;
    }
  };
  wrapped.idle = () => running ?? Promise.resolve();
  return wrapped;
}

export function startScheduler({ schedule, job, logger, cronLib = cron }) {
  if (!cronLib.validate(schedule.cron)) throw new Error(`invalid cron expression: ${schedule.cron}`);
  const guarded = nonOverlapping(async () => {
    try {
      return await job();
    } catch (err) {
      logger.error('scheduled run crashed', { error: err });
    }
  }, { logger });
  // Overlap is handled by `nonOverlapping` (structured log line) rather than node-cron's noOverlap,
  // which writes its own non-JSON warnings to the console.
  const task = cronLib.schedule(schedule.cron, guarded, { timezone: schedule.timezone });
  logger.info('scheduler started', { cron: schedule.cron, timezone: schedule.timezone || 'local' });
  return {
    async stop() {
      task.stop();
      await guarded.idle();
    },
  };
}
