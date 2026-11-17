// The env file (backup-manager.env) is the only supported configuration interface.
// It is parsed with Node's built-in util.parseEnv and mapped onto normalizeConfig().
// Every error names the env key the technician has to fix.

import fs from 'node:fs/promises';
import os from 'node:os';
import { parseEnv } from 'node:util';
import { ConfigError, normalizeConfig, parseEncryptionKey } from './config.js';

const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Every key the env file may contain. Anything else is reported as a typo. */
export const ENV_KEYS = [
  'SQL_HOST', 'SQL_PORT', 'SQL_INSTANCE', 'SQL_USER', 'SQL_PASSWORD', 'SQL_DATABASES', 'SQL_BACKUP_DIR',
  'SQL_LOCAL_BACKUP_DIR',
  'SQL_ENCRYPT', 'SQL_TRUST_SERVER_CERTIFICATE',
  'SERVER_NAME', 'GOOGLE_EMAIL', 'BACKUP_TIME', 'KEEP_LAST', 'KEEP_DAYS',
  'HEALTHCHECK_URL', 'BACKUP_ENCRYPTION_KEY', 'LOG_LEVEL',
];

/**
 * Parse KEY=VALUE text. Strips a UTF-8 BOM (older Notepad adds one) and refuses unquoted
 * values containing "#": util.parseEnv would silently cut them there, which breaks passwords.
 */
export function parseEnvText(text, where = 'env file') {
  const clean = text.replace(/^﻿/, '');
  for (const [i, line] of clean.split(/\r?\n/).entries()) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const value = m[2].trim();
    if (value.includes('#') && !/^['"`]/.test(value)) {
      throw new ConfigError(`${m[1]} (${where} line ${i + 1}) contains "#": put the value in single quotes, e.g. ${m[1]}='...'`);
    }
  }
  const vars = parseEnv(clean);
  const unknown = Object.keys(vars).filter((k) => !ENV_KEYS.includes(k));
  if (unknown.length) {
    throw new ConfigError(`unknown setting${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} in ${where} (check the spelling)`);
  }
  return vars;
}

/** Google's "Desktop app" client JSON ({ installed: { client_id, client_secret } }). */
export async function loadOAuthClient(file) {
  let data;
  try {
    data = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`cannot read Google OAuth client file ${file}: ${err.code || err.message} (the release package includes it)`);
  }
  const c = data.installed ?? data;
  if (!c?.client_id || !c?.client_secret) {
    throw new ConfigError(`${file} must contain installed.client_id and installed.client_secret`);
  }
  return { clientId: c.client_id, clientSecret: c.client_secret };
}

/** Computer name reduced to the characters allowed in Drive folder names. */
export function defaultServerName(hostname = os.hostname()) {
  const s = hostname.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '').slice(0, 64);
  return s || 'server';
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '.', '(local)'];

/**
 * True if SQL_HOST names this machine: localhost, a loopback address, "." / "(local)",
 * or the computer name (case-insensitive).
 */
export function isLocalSqlHost(host, { hostname = os.hostname(), computerName = process.env.COMPUTERNAME } = {}) {
  const h = String(host ?? '').trim().toLowerCase();
  if (!h) return false;
  if (LOCAL_HOSTS.includes(h)) return true;
  return [hostname, computerName].some((n) => n && n.toLowerCase() === h);
}

function req(cond, msg) {
  if (!cond) throw new ConfigError(msg);
}

function posInt(vars, key, dflt) {
  const v = vars[key];
  if (v === undefined || v === '') return dflt;
  req(/^\d+$/.test(v) && Number(v) > 0, `${key} must be a positive whole number, got "${v}"`);
  return Number(v);
}

function flag(vars, key, dflt) {
  const v = (vars[key] ?? '').toLowerCase();
  if (v === '') return dflt;
  req(v === 'true' || v === 'false', `${key} must be true or false, got "${vars[key]}"`);
  return v === 'true';
}

/**
 * Validate env vars and build the normalized config.
 * @param vars    parsed env file
 * @param google  { clientId, clientSecret } from oauth-client.json
 * @param paths   from appPaths()
 * @param requireSql  false for commands that never connect to SQL Server (list, download, auth,
 *                    check --skip-sql): SQL_PASSWORD, SQL_DATABASES and SQL_BACKUP_DIR may then be
 *                    empty (restore-only machines).
 *
 * SQL_BACKUP_DIR is the folder as SQL Server sees it (BACKUP DATABASE writes there). This program reads
 * the .bak from SQL_LOCAL_BACKUP_DIR, the same folder as seen from this machine, e.g. a share
 * \\sqlhost\Backup. Empty = SQL_BACKUP_DIR (SQL Server on this machine); required for a remote SQL_HOST.
 */
export function envToConfig(vars, { google, paths, hostname, computerName, requireSql = true } = {}) {
  const get = (k) => (vars[k] ?? '').trim();

  const host = get('SQL_HOST') || 'localhost';
  const port = posInt(vars, 'SQL_PORT', 1433);
  req(port < 65536, `SQL_PORT must be a TCP port (1-65535), got "${vars.SQL_PORT}"`);
  // A named instance is found through the SQL Browser service. Setting SQL_PORT to the instance's
  // fixed port (anything but the template's default 1433) bypasses the Browser.
  const instanceName = get('SQL_INSTANCE') && (get('SQL_PORT') === '' || port === 1433) ? get('SQL_INSTANCE') : undefined;
  req(!requireSql || get('SQL_USER'), 'SQL_USER is empty (the installer fills it in when it creates the SQL login: run it again; '
    + 'otherwise enter an existing SQL login and its password in SQL_PASSWORD)');
  req(!requireSql || (vars.SQL_PASSWORD ?? '') !== '',
    'SQL_PASSWORD is empty (the installer fills it in when it creates the SQL login: run it again; '
    + 'if SQL Server was prepared by hand with sql-prepare.sql, enter that password)');
  const databases = get('SQL_DATABASES').split(',').map((d) => d.trim()).filter(Boolean);
  req(!requireSql || databases.length, 'SQL_DATABASES is empty (comma-separated database names, exactly as shown in SSMS)');
  req(new Set(databases).size === databases.length, 'SQL_DATABASES lists the same database twice');
  for (const db of databases) req(!/[\x00-\x1f\][]/.test(db) && db.length <= 128, `SQL_DATABASES: invalid database name "${db}"`);
  const backupDir = get('SQL_BACKUP_DIR');
  req(!requireSql || backupDir, 'SQL_BACKUP_DIR is empty (set it to the folder SQL Server writes backups to: SSMS > server '
    + 'Properties > Database Settings > Backup; the installer fills it in only when it prepares a local SQL Server)');
  const localBackupDir = get('SQL_LOCAL_BACKUP_DIR');
  const local = isLocalSqlHost(host, { hostname, computerName });
  req(!requireSql || local || localBackupDir,
    `SQL_LOCAL_BACKUP_DIR is empty, but SQL_HOST "${host}" is another machine: SQL Server writes the backup there, `
    + 'so this program needs that folder as a network share. Set SQL_LOCAL_BACKUP_DIR to the share of SQL_BACKUP_DIR, '
    + 'e.g. \\\\sqlhost\\Backup');

  const serverName = get('SERVER_NAME') || defaultServerName(hostname);
  req(/^[A-Za-z0-9._-]{1,64}$/.test(serverName), `SERVER_NAME may only contain letters, digits, ".", "_" and "-" (max 64), got "${serverName}"`);

  const googleEmail = get('GOOGLE_EMAIL');
  req(!googleEmail || EMAIL_RE.test(googleEmail), `GOOGLE_EMAIL is not an email address: "${googleEmail}"`);

  const backupTime = get('BACKUP_TIME') || '02:00';
  req(TIME_RE.test(backupTime), `BACKUP_TIME must be HH:MM (24-hour), got "${backupTime}"`);

  const keepLast = posInt(vars, 'KEEP_LAST', undefined);
  const keepDays = posInt(vars, 'KEEP_DAYS', undefined);

  const heartbeatUrl = get('HEALTHCHECK_URL');
  if (heartbeatUrl) {
    let u;
    try {
      u = new URL(heartbeatUrl);
    } catch {
      u = null;
    }
    req(u && u.protocol === 'https:', 'HEALTHCHECK_URL must be an https:// URL (e.g. https://hc-ping.com/<uuid>)');
  }

  const logLevel = get('LOG_LEVEL').toLowerCase() || undefined;
  req(!logLevel || ['debug', 'info', 'warn', 'error'].includes(logLevel), `LOG_LEVEL must be debug, info, warn or error, got "${vars.LOG_LEVEL}"`);

  const keyText = get('BACKUP_ENCRYPTION_KEY');
  req(keyText, 'BACKUP_ENCRYPTION_KEY is empty (the installer generates one; never change it after the first backup)');
  const key = parseEncryptionKey(keyText, 'BACKUP_ENCRYPTION_KEY');

  const raw = {
    google: { ...google, tokenFile: paths.tokenFile },
    servers: [{
      name: serverName,
      host,
      port,
      instanceName,
      user: get('SQL_USER'),
      password: vars.SQL_PASSWORD ?? '',
      encrypt: flag(vars, 'SQL_ENCRYPT', true),
      // SQL Server's certificate is self-signed by default; for a connection to this machine that is fine.
      trustServerCertificate: flag(vars, 'SQL_TRUST_SERVER_CERTIFICATE', local),
      databases,
      backupDir,
      localBackupDir: localBackupDir || backupDir,
      nativeCompression: false, // not available on Express; gzip is used instead
    }],
    retention: { keepLast, keepDays },
    compression: true,
    encryption: { enabled: true, keyEnv: 'BACKUP_ENCRYPTION_KEY' },
    workDir: paths.workDir,
    monitoring: { heartbeatUrl: heartbeatUrl || undefined },
  };
  const config = normalizeConfig(raw, { env: { BACKUP_ENCRYPTION_KEY: key.toString('base64') }, resolveRefs: false, requireSql });
  return {
    ...config,
    googleEmail: googleEmail || undefined,
    sqlInstance: get('SQL_INSTANCE') || undefined,
    backupTime,
    logLevel,
    envFile: paths.envFile,
    logDir: paths.logDir,
  };
}

/** Read the env file + OAuth client and return the normalized config. */
export async function loadEnvConfig(paths, { hostname, requireSql = true } = {}) {
  let text;
  try {
    text = await fs.readFile(paths.envFile, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read ${paths.envFile}: ${err.code || err.message} (run the installer to create it)`);
  }
  const vars = parseEnvText(text, paths.envFile);
  const google = await loadOAuthClient(paths.oauthClientFile);
  return envToConfig(vars, { google, paths, hostname, requireSql });
}
