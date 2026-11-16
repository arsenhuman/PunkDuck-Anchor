import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import * as auth from './auth.js';
import { downloadBackup, listBackups, runBackups } from './backup.js';
import { DEFAULT_CONFIG_PATH, loadConfig } from './config.js';
import { DriveStore } from './drive.js';
import { fmtBytes } from './format.js';
import { sendHeartbeat } from './heartbeat.js';
import { createLogger } from './logger.js';
import { MssqlClient } from './mssql.js';
import { startScheduler } from './scheduler.js';

export const USAGE = `Usage: backup-manager <command> [options]

Commands:
  auth login [--email you@gmail.com]   Connect a Google account (OAuth, opens consent URL)
  auth status                          Show the connected Google account
  auth logout                          Revoke and delete the stored token
  backup [--server S] [--db D]         Back up configured databases now
  list [--server S] [--db D]           List backups stored on Google Drive
  download <fileId> [--out DIR] [--force]
                                       Download + decrypt + decompress a backup to .bak
  download latest --db D [--server S] [--out DIR] [--force]
  schedule                             Run backups on the configured cron schedule
  keygen                               Print a new random encryption key (base64)

Options:
  -c, --config PATH   Config file (default ${DEFAULT_CONFIG_PATH})
  -h, --help          Show this help
`;

const OPTIONS = {
  config: { type: 'string', short: 'c', default: DEFAULT_CONFIG_PATH },
  server: { type: 'string' },
  db: { type: 'string' },
  out: { type: 'string', default: '.' },
  email: { type: 'string' },
  json: { type: 'boolean', default: false },
  force: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

async function makeDrive(config, logger) {
  const client = await auth.getAuthorizedClient(config.google);
  return new DriveStore({ request: (o) => client.request(o), logger });
}

/** Returns the process exit code. */
export async function main(argv, { stdout = process.stdout, logger = createLogger() } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (err) {
    stdout.write(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  const { values: opts, positionals } = parsed;
  const [cmd, sub] = positionals;
  if (opts.help || !cmd) {
    stdout.write(USAGE);
    return cmd || opts.help ? 0 : 2;
  }
  const out = (s) => stdout.write(s + '\n');
  const filter = { server: opts.server, db: opts.db };

  if (cmd === 'keygen') {
    out(crypto.randomBytes(32).toString('base64'));
    return 0;
  }

  const config = await loadConfig(opts.config);

  switch (cmd) {
    case 'auth': {
      if (sub === 'login') {
        const email = await auth.login(config.google, {
          loginHint: opts.email,
          prompt: (url) => out(`Open this URL in a browser and approve access:\n\n  ${url}\n\nWaiting for authorization...`),
        });
        out(`Connected Google account: ${email}`);
        if (opts.email && email && email.toLowerCase() !== opts.email.toLowerCase()) {
          out(`Warning: you signed in as ${email}, not ${opts.email}.`);
        }
        return 0;
      }
      if (sub === 'status') {
        const s = await auth.status(config.google);
        out(s.loggedIn ? `Logged in as ${s.email} (token: ${s.tokenFile})` : 'Not logged in.');
        return s.loggedIn ? 0 : 1;
      }
      if (sub === 'logout') {
        const r = await auth.logout(config.google);
        out(r.removed ? `Logged out${r.revoked ? ' (token revoked)' : ' (local token removed; revoke failed)'}.` : 'Not logged in.');
        return 0;
      }
      out(`Unknown auth subcommand: ${sub ?? '(none)'}\n\n${USAGE}`);
      return 2;
    }

    case 'backup': {
      const drive = await makeDrive(config, logger);
      const { results, failed } = await runBackups({
        config, drive, logger, filter, createSqlClient: (s) => new MssqlClient(s),
      });
      if (opts.json) out(JSON.stringify(results, null, 2));
      else for (const r of results) {
        out(r.ok
          ? `OK    ${r.server}/${r.db}  ${r.name}  ${fmtBytes(r.bytes)}  (${r.deleted} old removed)${r.retentionError ? `  [retention failed: ${r.retentionError}]` : ''}`
          : `FAIL  ${r.server}/${r.db}  ${r.error}`);
      }
      await sendHeartbeat({ url: config.monitoring.heartbeatUrl, results, failed, logger });
      return failed ? 1 : 0;
    }

    case 'list': {
      const drive = await makeDrive(config, logger);
      const items = await listBackups({ config, drive, filter });
      if (opts.json) out(JSON.stringify(items, null, 2));
      else if (!items.length) out('No backups found.');
      else for (const b of items) out(`${b.createdTime}  ${b.server}/${b.db}  ${b.name}  ${fmtBytes(b.size)}  id=${b.id}`);
      return 0;
    }

    case 'download': {
      if (!sub) {
        out(`download needs a file id or "latest"\n\n${USAGE}`);
        return 2;
      }
      const drive = await makeDrive(config, logger);
      const latest = sub === 'latest';
      const r = await downloadBackup({ config, drive, logger, filter, latest, fileId: latest ? undefined : sub, outDir: opts.out, force: opts.force });
      out(`Saved ${r.dest}`);
      return 0;
    }

    case 'schedule': {
      if (!config.schedule) {
        out('No "schedule" section in config.');
        return 2;
      }
      await auth.getAuthorizedClient(config.google); // fail fast if not logged in
      const scheduler = startScheduler({
        schedule: config.schedule,
        logger,
        job: async () => {
          const drive = await makeDrive(config, logger);
          const { results, failed } = await runBackups({ config, drive, logger, createSqlClient: (s) => new MssqlClient(s) });
          logger.info('scheduled run finished', { total: results.length, failed });
          await sendHeartbeat({ url: config.monitoring.heartbeatUrl, results, failed, logger });
        },
      });
      await new Promise((resolve) => {
        const shutdown = (sig) => {
          logger.info('shutting down, waiting for running backup to finish', { signal: sig });
          scheduler.stop().then(resolve);
        };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
      });
      return 0;
    }

    default:
      out(`Unknown command: ${cmd}\n\n${USAGE}`);
      return 2;
  }
}
