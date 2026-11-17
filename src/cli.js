import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import * as auth from './auth.js';
import { downloadBackup, listBackups, runBackups } from './backup.js';
import { formatChecks, runChecks } from './check.js';
import { loadConfig } from './config.js';
import { DriveStore } from './drive.js';
import { loadEnvConfig, loadOAuthClient } from './envconfig.js';
import { fmtBytes } from './format.js';
import { sendHeartbeat } from './heartbeat.js';
import { cleanupLogs, createLogger } from './logger.js';
import { MssqlClient } from './mssql.js';
import { appPaths } from './paths.js';

export const LOG_KEEP_DAYS = 30;

export const USAGE = `Usage: backup-manager <command> [options]

Commands:
  check                                Verify settings, SQL Server, backup folder and Google sign-in
  auth login [--email you@gmail.com]   Connect a Google account (prints a sign-in URL)
  auth status                          Show the connected Google account
  auth logout                          Revoke and delete the stored Google sign-in
  backup [--db D]                      Back up the configured databases now
  list [--db D] [--server S]           List backups stored on Google Drive
  download <fileId> [--out DIR] [--force]
                                       Download + decrypt + decompress a backup to .bak
  download latest --db D [--server S] [--out DIR] [--force]
  keygen                               Print a new random encryption key (base64)

Settings are read from backup-manager.env in the data folder
(C:\\ProgramData\\backup-manager, or BACKUP_MANAGER_HOME).

Options:
  -h, --help          Show this help
`;

const OPTIONS = {
  config: { type: 'string', short: 'c' }, // internal: JSON config instead of the env file
  server: { type: 'string' },
  db: { type: 'string' },
  out: { type: 'string', default: '.' },
  email: { type: 'string' },
  json: { type: 'boolean', default: false },
  force: { type: 'boolean', default: false },
  'skip-auth': { type: 'boolean', default: false }, // check: used by install.ps1 before the first sign-in
  help: { type: 'boolean', short: 'h', default: false },
};

const COMMANDS = ['check', 'auth', 'backup', 'list', 'download', 'keygen'];

const LOGIN_HELP = `
No browser on this machine? Open the URL on your own computer and approve access.
Your browser then fails to load a page at http://127.0.0.1:... - that is expected.
Copy that full address from the address bar, paste it here and press Enter.`;

/** Exit code 1 when the local token was removed but revoking it at Google failed. */
async function logoutCommand(google, out) {
  const r = await auth.logout(google);
  if (!r.removed) {
    out('Not logged in.');
    return 0;
  }
  out(r.revoked ? 'Logged out (token revoked).' : 'Local token removed, but revoking it at Google failed.');
  return r.revoked ? 0 : 1;
}

async function makeDrive(config, logger) {
  const client = await auth.getAuthorizedClient(config.google);
  return new DriveStore({ request: (o) => client.request(o), logger });
}

/**
 * Returns the process exit code.
 * Injectable for tests: stdout, stdin, logger, env (for BACKUP_MANAGER_HOME), createSqlClient, authStatus.
 */
export async function main(argv, {
  stdout = process.stdout,
  stdin = process.stdin,
  logger: injectedLogger,
  env = process.env,
  createSqlClient = (s) => new MssqlClient(s),
  authStatus = auth.status,
} = {}) {
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

  if (!COMMANDS.includes(cmd)) {
    out(`Unknown command: ${cmd}\n\n${USAGE}`);
    return 2;
  }

  if (cmd === 'keygen') {
    out(crypto.randomBytes(32).toString('base64'));
    return 0;
  }

  const paths = appPaths({ env });
  const load = () => (opts.config ? loadConfig(opts.config) : loadEnvConfig(paths));

  if (cmd === 'check') {
    const { ok, checks } = await runChecks({
      loadConfig: load, createSqlClient, authStatus, skipAuth: opts['skip-auth'], envFile: paths.envFile,
    });
    out(formatChecks(checks));
    out(ok ? '\nAll checks passed.' : '\nSome checks failed. Fix the problems above and run "backup-manager check" again.');
    return ok ? 0 : 1;
  }

  // Logout must work even with a broken env file (uninstall.ps1 -Purge): it needs only the token and OAuth client.
  if (cmd === 'auth' && sub === 'logout' && !opts.config) {
    const google = { ...(await loadOAuthClient(paths.oauthClientFile)), tokenFile: paths.tokenFile };
    return logoutCommand(google, out);
  }

  // Settings errors and command failures also go to the log file: for runs started by Task Scheduler
  // the log is the only record.
  const logDir = opts.config ? undefined : paths.logDir;
  let config;
  try {
    config = await load();
  } catch (err) {
    (injectedLogger ?? createLogger({ logDir, level: env.LOG_LEVEL ?? 'info' })).error('cannot load settings', { command: cmd, error: err });
    throw err;
  }
  let logger = injectedLogger;
  if (!logger) {
    logger = createLogger({ logDir: config.logDir, level: config.logLevel ?? env.LOG_LEVEL ?? 'info' });
    if (config.logDir) {
      const deleted = cleanupLogs(config.logDir, { keepDays: LOG_KEEP_DAYS });
      if (deleted.length) logger.info('old log files deleted', { count: deleted.length });
    }
  }

  try {
    return await dispatch({ cmd, sub, opts, config, logger, out, filter, stdin, createSqlClient });
  } catch (err) {
    logger.error(`${cmd} failed`, { error: err });
    throw err;
  }
}

async function dispatch({ cmd, sub, opts, config, logger, out, filter, stdin, createSqlClient }) {
  switch (cmd) {
    case 'auth': {
      if (sub === 'login') {
        const wanted = opts.email ?? config.googleEmail;
        const email = await auth.login(config.google, {
          loginHint: wanted,
          input: stdin,
          prompt: (url) => out(`Open this URL in a browser and approve access${wanted ? ` as ${wanted}` : ''}:\n\n  ${url}\n${LOGIN_HELP}\n\nWaiting for authorization...`),
          onInvalidPaste: (err) => out(`That did not work (${err.message}). Paste the full http://127.0.0.1:... address and press Enter.`),
        });
        out(`Connected Google account: ${email}`);
        if (wanted && email && email.toLowerCase() !== wanted.toLowerCase()) {
          out(`Warning: you signed in as ${email}, not ${wanted}.`);
        }
        return 0;
      }
      if (sub === 'status') {
        const s = await auth.status(config.google);
        out(s.loggedIn ? `Logged in as ${s.email} (token: ${s.tokenFile})` : 'Not logged in.');
        return s.loggedIn ? 0 : 1;
      }
      if (sub === 'logout') return logoutCommand(config.google, out);
      out(`Unknown auth subcommand: ${sub ?? '(none)'}\n\n${USAGE}`);
      return 2;
    }

    case 'backup': {
      const drive = await makeDrive(config, logger);
      const { results, failed } = await runBackups({
        config, drive, logger, filter, createSqlClient,
      });
      logger.info('backup run finished', { total: results.length, failed });
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

    default:
      out(`Unknown command: ${cmd}\n\n${USAGE}`);
      return 2;
  }
}
