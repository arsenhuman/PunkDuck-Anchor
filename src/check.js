// `backup-manager check`: verify the whole setup and explain every failure in plain words.
// All collaborators are injected so this runs in tests without SQL Server or Google.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { formatSqlError, MIN_SQL_MAJOR, sqlErrorNumbers } from './mssql.js';

/** T-SQL identifier in brackets, as QUOTENAME() writes it. */
const bracket = (name) => `[${String(name).replace(/]/g, ']]')}]`;

const RERUN_HINT = 'Or run the installer again as a SQL Server sysadmin (it sets this up), '
  + 'or have the DBA run C:\\Program Files\\backup-manager\\sql-prepare.sql.';

/** The exact SQL that gives SQL_USER the permission RESTORE VERIFYONLY needs. */
export function verifyGrantFix(user) {
  const u = bracket(user);
  return 'RESTORE VERIFYONLY needs CREATE DATABASE permission in master. As a sysadmin, run in SSMS: '
    + `USE master; CREATE USER ${u} FOR LOGIN ${u}; GRANT CREATE DATABASE TO ${u}; `
    + `(skip CREATE USER if the user already exists). ${RERUN_HINT}`;
}

/** The exact SQL that gives SQL_USER backup rights on one database. */
export function backupGrantFix(user, db) {
  const u = bracket(user);
  return `As a sysadmin, run in SSMS: USE ${bracket(db)}; CREATE USER ${u} FOR LOGIN ${u}; `
    + `ALTER ROLE db_backupoperator ADD MEMBER ${u}; (skip CREATE USER if the user already exists). ${RERUN_HINT}`;
}

/**
 * Map a SQL error to a plain-language explanation + fix.
 * Covers the usual traps of a new SQL Server (Express in particular).
 */
export function explainSqlError(err, server = {}) {
  const msg = String(err?.message ?? err);
  const code = err?.code ?? err?.originalError?.code;
  const where = server.instanceName ? `${server.host}\\${server.instanceName}` : `${server.host}:${server.port}`;
  if (sqlErrorNumbers(err).includes(262)) {
    return {
      problem: `SQL_USER "${server.user}" may not verify backups (${formatSqlError(err)})`,
      fix: verifyGrantFix(server.user),
    };
  }
  if (code === 'EINSTLOOKUP' || /SQL Server Browser|instance lookup|Port for .* not found/i.test(msg)) {
    return {
      problem: `Could not find the named instance ${where}: the SQL Server Browser service is probably stopped.`,
      fix: 'Start the "SQL Server Browser" service (services.msc, startup type Automatic), or set SQL_PORT to the instance\'s fixed TCP port.',
    };
  }
  if (code === 'ELOGIN' || /Login failed/i.test(msg)) {
    return {
      problem: `SQL Server refused the login for SQL_USER "${server.user}".`,
      fix: 'Check SQL_USER / SQL_PASSWORD and that the login is enabled. SQL logins also need mixed mode: '
        + 'SSMS > server Properties > Security > "SQL Server and Windows Authentication mode", then restart the SQL Server service. '
        + RERUN_HINT,
    };
  }
  if (/self[- ]signed|certificate/i.test(msg)) {
    return {
      problem: `The TLS certificate of ${where} is not trusted (SQL Server uses a self-signed certificate by default).`,
      fix: 'For a SQL Server on this machine, use SQL_HOST=localhost and remove SQL_TRUST_SERVER_CERTIFICATE=false '
        + 'from the env file (or set it to true). For a SQL Server on another machine on the client\'s network, '
        + 'add SQL_TRUST_SERVER_CERTIFICATE=true, or install a trusted certificate on that SQL Server.',
    };
  }
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) {
    return { problem: `The host name in SQL_HOST ("${server.host}") does not exist.`, fix: 'Use localhost for a SQL Server on this machine, otherwise its computer name or IP address.' };
  }
  if (code === 'ESOCKET' || code === 'ETIMEOUT' || /ECONNREFUSED|ETIMEDOUT|Failed to connect|timeout/i.test(msg)) {
    return {
      problem: `Could not reach SQL Server at ${where}: TCP/IP is probably disabled (the default on new installs, especially Express) or the port is wrong.`,
      fix: 'Open SQL Server Configuration Manager > SQL Server Network Configuration > Protocols, enable TCP/IP, '
        + 'then restart the SQL Server service. For a named instance without a fixed port, the SQL Server Browser service must run.',
    };
  }
  return { problem: `SQL Server error: ${formatSqlError(err)}`, fix: 'Check the SQL_* settings in the env file.' };
}

/**
 * @param deps {
 *   loadConfig(): Promise<config>,
 *   createSqlClient(server),
 *   authStatus(google): Promise<{loggedIn, email}>,
 *   skipAuth?: boolean,   // installer: check before the first Google sign-in
 *   skipSql?: boolean,    // restore-only machine: no SQL connection, databases or backup folder
 *   envFile?: string,     // only for the error hint
 * }
 * @returns {Promise<{ok: boolean, checks: {name, ok, detail?, fix?, skipped?}[]}>}
 */
export async function runChecks({ loadConfig, createSqlClient, authStatus, skipAuth = false, skipSql = false, envFile }) {
  const checks = [];
  const add = (c) => checks.push({ ok: true, ...c });
  const fail = (name, problem, fix) => checks.push({ name, ok: false, detail: problem, fix });
  const skip = (name, detail) => checks.push({ name, ok: true, skipped: true, detail });

  let config;
  try {
    config = await loadConfig();
    add({ name: 'Settings', detail: config.envFile ?? 'valid' });
  } catch (err) {
    fail('Settings', err.message, `Edit ${envFile ?? 'the env file'} and run check again.`);
    return { ok: false, checks };
  }

  const server = config.servers[0];

  if (skipSql) {
    skip('SQL connection', 'skipped (--skip-sql)');
    skip('Backup folder', 'skipped (--skip-sql)');
  } else {
    await checkSql(server, createSqlClient, checks, { add, fail });
    await checkBackupFolder(server, { add, fail });
  }

  // Work folder for compressed/encrypted files
  try {
    await fs.mkdir(config.workDir, { recursive: true, mode: 0o700 });
    await fs.access(config.workDir, fs.constants.W_OK);
    add({ name: 'Work folder', detail: config.workDir });
  } catch (err) {
    fail('Work folder', `cannot write to ${config.workDir} (${err.code || err.message})`, 'Run as Administrator or SYSTEM.');
  }

  // Google
  if (skipAuth) {
    skip('Google account', 'skipped');
  } else {
    try {
      const s = await authStatus(config.google);
      if (!s.loggedIn) {
        fail('Google account', 'not signed in to Google', 'Run: backup-manager auth login');
      } else if (config.googleEmail && s.email?.toLowerCase() !== config.googleEmail.toLowerCase()) {
        fail('Google account', `signed in as ${s.email}, but GOOGLE_EMAIL is ${config.googleEmail}`,
          'Run "backup-manager auth logout", then "backup-manager auth login" with the right account (or fix GOOGLE_EMAIL).');
      } else {
        add({ name: 'Google account', detail: `signed in as ${s.email}` });
      }
    } catch (err) {
      fail('Google account', `the stored Google sign-in does not work: ${err.message}`,
        'Access was probably revoked or expired. Run: backup-manager auth login');
    }
  }

  // Monitoring (the URL format is validated with the settings)
  add({ name: 'Healthchecks', detail: config.monitoring.heartbeatUrl ? `ping URL set (${new URL(config.monitoring.heartbeatUrl).host})` : 'HEALTHCHECK_URL not set: monitoring is off' });

  return { ok: checks.every((c) => c.ok), checks };
}

/** Connection, version, verify permission (once per server) and every database. */
async function checkSql(server, createSqlClient, checks, { add, fail }) {
  const where = server.instanceName ? `${server.host}\\${server.instanceName}` : `${server.host}:${server.port}`;
  let sql;
  let connected = false;
  try {
    sql = createSqlClient(server);
    await sql.connect();
    connected = true;
    const info = await sql.serverInfo();
    const label = [info.edition, info.version].filter(Boolean).join(' ');
    if (info.major && info.major < MIN_SQL_MAJOR) {
      fail('SQL connection', `connected, but ${label} is older than SQL Server 2016`, 'Upgrade SQL Server to 2016 or newer.');
    } else {
      add({ name: 'SQL connection', detail: `${where} (${label || 'unknown version'})` });
    }
    if (await sql.canVerify()) {
      add({ name: 'Verify permission', detail: 'CREATE DATABASE in master OK (needed by RESTORE VERIFYONLY)' });
    } else {
      fail('Verify permission', `SQL_USER "${server.user}" has no CREATE DATABASE permission in master, so verifying backups would fail`,
        verifyGrantFix(server.user));
    }
    for (const db of server.databases) {
      try {
        await sql.assertDatabaseOnline(db);
      } catch (err) {
        fail(`Database ${db}`, err.message, 'Check the name in SQL_DATABASES (names are as shown in SSMS) and that the database is ONLINE.');
        continue;
      }
      if (await sql.canBackup(db)) add({ name: `Database ${db}`, detail: 'ONLINE, BACKUP permission OK' });
      else fail(`Database ${db}`, `SQL_USER "${server.user}" has no BACKUP DATABASE permission on ${db}`, backupGrantFix(server.user, db));
    }
  } catch (err) {
    const e = explainSqlError(err, server);
    if (connected) {
      fail('SQL error', e.problem, e.fix);
    } else {
      fail('SQL connection', e.problem, e.fix);
      for (const name of ['Verify permission', ...server.databases.map((db) => `Database ${db}`)]) {
        checks.push({ name, ok: false, skipped: true, detail: 'skipped (no SQL connection)' });
      }
    }
  } finally {
    await sql?.close().catch(() => {});
  }
}

/** SQL Server writes the .bak to SQL_BACKUP_DIR; this program must read and delete it there. */
async function checkBackupFolder(server, { add, fail }) {
  const dir = server.localBackupDir;
  try {
    const st = await fs.stat(dir);
    if (!st.isDirectory()) throw Object.assign(new Error('not a folder'), { code: 'ENOTDIR' });
    const probe = path.join(dir, `.backup-manager-check-${crypto.randomBytes(4).toString('hex')}.tmp`);
    await fs.writeFile(probe, 'probe');
    await fs.readFile(probe);
    await fs.rm(probe);
    add({ name: 'Backup folder', detail: `${dir} (readable, deletable)` });
  } catch (err) {
    const why = err.code === 'ENOENT' ? 'does not exist'
      : err.code === 'ENOTDIR' ? 'is not a folder'
        : `is not readable/deletable by this program (${err.code || err.message})`;
    const key = server.backupDir && dir !== path.resolve(server.backupDir) ? 'SQL_LOCAL_BACKUP_DIR' : 'SQL_BACKUP_DIR';
    const fix = key === 'SQL_BACKUP_DIR'
      ? 'Set SQL_BACKUP_DIR to the folder SQL Server writes backups to (SSMS > server Properties > Database Settings > Backup).'
      : 'Set SQL_LOCAL_BACKUP_DIR to the network share of SQL_BACKUP_DIR, and give the account this program runs as '
        + '(the scheduled task runs as SYSTEM, i.e. this computer\'s account on the network) read and delete rights on it.';
    fail('Backup folder', `${key} ${dir} ${why}`, fix);
  }
}

export function formatChecks(checks) {
  const lines = [];
  for (const c of checks) {
    const tag = c.skipped ? ' -- ' : c.ok ? ' OK ' : 'FAIL';
    lines.push(`[${tag}] ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
    if (!c.ok && c.fix) lines.push(`       Fix: ${c.fix}`);
  }
  return lines.join('\n');
}
