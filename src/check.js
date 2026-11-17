// `backup-manager check`: verify the whole setup and explain every failure in plain words.
// All collaborators are injected so this runs in tests without SQL Server or Google.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MIN_SQL_MAJOR } from './mssql.js';

/**
 * Map a SQL connection/login error to a plain-language explanation + fix.
 * Covers the usual SQL Server Express traps.
 */
export function explainSqlError(err, server = {}) {
  const msg = String(err?.message ?? err);
  const code = err?.code ?? err?.originalError?.code;
  const where = server.instanceName ? `${server.host}\\${server.instanceName}` : `${server.host}:${server.port}`;
  if (code === 'EINSTLOOKUP' || /SQL Server Browser|instance lookup|Port for .* not found/i.test(msg)) {
    return {
      problem: `Could not find the named instance ${where}: the SQL Server Browser service is probably stopped.`,
      fix: 'Start the "SQL Server Browser" service (services.msc, startup type Automatic), or set SQL_PORT to the instance\'s fixed TCP port.',
    };
  }
  if (code === 'ELOGIN' || /Login failed/i.test(msg)) {
    return {
      problem: `SQL Server refused the login for SQL_USER "${server.user}".`,
      fix: 'Check SQL_USER / SQL_PASSWORD and that the login is enabled. On SQL Server Express, also enable mixed mode: '
        + 'SSMS > server Properties > Security > "SQL Server and Windows Authentication mode", then restart the SQL Server service.',
    };
  }
  if (/self[- ]signed|certificate/i.test(msg)) {
    return {
      problem: `The TLS certificate of ${where} is not trusted (SQL Server Express uses a self-signed certificate).`,
      fix: 'For a SQL Server on this machine, add SQL_TRUST_SERVER_CERTIFICATE=true to the env file.',
    };
  }
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) {
    return { problem: `The host name in SQL_HOST ("${server.host}") does not exist.`, fix: 'Use localhost for a SQL Server on this machine.' };
  }
  if (code === 'ESOCKET' || code === 'ETIMEOUT' || /ECONNREFUSED|ETIMEDOUT|Failed to connect|timeout/i.test(msg)) {
    return {
      problem: `Could not reach SQL Server at ${where}: TCP/IP is probably disabled (the SQL Server Express default) or the port is wrong.`,
      fix: 'Open SQL Server Configuration Manager > SQL Server Network Configuration > Protocols, enable TCP/IP, '
        + 'then restart the SQL Server service. For a named instance without a fixed port, the SQL Server Browser service must run.',
    };
  }
  return { problem: `SQL Server error: ${msg}`, fix: 'Check the SQL_* settings in the env file.' };
}

/**
 * @param deps {
 *   loadConfig(): Promise<config>,
 *   createSqlClient(server),
 *   authStatus(google): Promise<{loggedIn, email}>,
 *   skipAuth?: boolean,   // installer: check before the first Google sign-in
 *   envFile?: string,     // only for the error hint
 * }
 * @returns {Promise<{ok: boolean, checks: {name, ok, detail?, fix?, skipped?}[]}>}
 */
export async function runChecks({ loadConfig, createSqlClient, authStatus, skipAuth = false, envFile }) {
  const checks = [];
  const add = (c) => checks.push({ ok: true, ...c });
  const fail = (name, problem, fix) => checks.push({ name, ok: false, detail: problem, fix });

  let config;
  try {
    config = await loadConfig();
    add({ name: 'Settings', detail: config.envFile ?? 'valid' });
  } catch (err) {
    fail('Settings', err.message, `Edit ${envFile ?? 'the env file'} and run check again.`);
    return { ok: false, checks };
  }

  const server = config.servers[0];

  // SQL Server
  let sql;
  try {
    sql = createSqlClient(server);
    await sql.connect();
    const info = await sql.serverInfo();
    const label = [info.edition, info.version].filter(Boolean).join(' ');
    if (info.major && info.major < MIN_SQL_MAJOR) {
      fail('SQL connection', `connected, but ${label} is older than SQL Server 2016`, 'Upgrade SQL Server to 2016 or newer.');
    } else {
      add({ name: 'SQL connection', detail: `${server.instanceName ? `${server.host}\\${server.instanceName}` : `${server.host}:${server.port}`} (${label || 'unknown version'})` });
    }
    for (const db of server.databases) {
      try {
        await sql.assertDatabaseOnline(db);
      } catch (err) {
        fail(`Database ${db}`, err.message, 'Check the name in SQL_DATABASES (names are as shown in SSMS) and that the database is ONLINE.');
        continue;
      }
      if (await sql.canBackup(db)) add({ name: `Database ${db}`, detail: 'ONLINE, BACKUP permission OK' });
      else {
        fail(`Database ${db}`, `SQL_USER "${server.user}" has no BACKUP DATABASE permission on ${db}`,
          `In SSMS, map the login to ${db} and add it to the db_backupoperator role.`);
      }
    }
  } catch (err) {
    const e = explainSqlError(err, server);
    fail('SQL connection', e.problem, e.fix);
    for (const db of server.databases) checks.push({ name: `Database ${db}`, ok: false, skipped: true, detail: 'skipped (no SQL connection)' });
  } finally {
    await sql?.close().catch(() => {});
  }

  // Backup folder: SQL Server writes the .bak there; we must read and delete it.
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
    fail('Backup folder', `SQL_BACKUP_DIR ${dir} ${why}`,
      'Set SQL_BACKUP_DIR to the folder SQL Server writes backups to (SSMS > server Properties > Database Settings > Backup).');
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
    checks.push({ name: 'Google account', ok: true, skipped: true, detail: 'skipped' });
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

export function formatChecks(checks) {
  const lines = [];
  for (const c of checks) {
    const tag = c.skipped ? ' -- ' : c.ok ? ' OK ' : 'FAIL';
    lines.push(`[${tag}] ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
    if (!c.ok && c.fix) lines.push(`       Fix: ${c.fix}`);
  }
  return lines.join('\n');
}
