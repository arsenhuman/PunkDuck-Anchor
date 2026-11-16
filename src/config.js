import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const DEFAULT_CONFIG_PATH = './backup-manager.json';
const DB_NAME_RE = /^[^\x00-\x1f\]\[]{1,128}$/;
const SERVER_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Expand "~" and resolve "env:VAR" references (recursively). */
export function resolveEnvRefs(value, env = process.env, where = 'config') {
  if (typeof value === 'string' && value.startsWith('env:')) {
    const name = value.slice(4);
    if (!(name in env) || env[name] === '') {
      throw new ConfigError(`${where}: environment variable ${name} is not set`);
    }
    return env[name];
  }
  if (Array.isArray(value)) return value.map((v, i) => resolveEnvRefs(v, env, `${where}[${i}]`));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveEnvRefs(v, env, `${where}.${k}`);
    return out;
  }
  return value;
}

export function expandHome(p) {
  if (typeof p !== 'string') return p;
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

function req(cond, msg) {
  if (!cond) throw new ConfigError(msg);
}

const isPosInt = (n) => Number.isInteger(n) && n > 0;

/** Strict boolean: true/false, or the strings "true"/"false" (useful with env: refs). */
function bool(value, name, dflt) {
  if (value === undefined) return dflt;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new ConfigError(`${name} must be true or false, got ${JSON.stringify(value)}`);
}

/** Validate and apply defaults. Returns a new, normalized config object. */
export function normalizeConfig(raw, { env = process.env } = {}) {
  req(raw && typeof raw === 'object' && !Array.isArray(raw), 'config must be a JSON object');
  const c = resolveEnvRefs(raw, env);

  // google
  req(c.google && typeof c.google === 'object', 'google section is required');
  req(typeof c.google.clientId === 'string' && c.google.clientId, 'google.clientId is required');
  req(typeof c.google.clientSecret === 'string' && c.google.clientSecret, 'google.clientSecret is required');
  const google = {
    clientId: c.google.clientId,
    clientSecret: c.google.clientSecret,
    tokenFile: path.resolve(expandHome(c.google.tokenFile || '~/.config/backup-manager/token.json')),
  };

  // drive
  const rootFolder = c.drive?.rootFolder ?? 'MSSQL Backups';
  req(typeof rootFolder === 'string' && rootFolder.trim() && !rootFolder.includes('/'),
    'drive.rootFolder must be a non-empty folder name without "/"');

  // servers
  req(Array.isArray(c.servers) && c.servers.length > 0, 'servers must be a non-empty array');
  const names = new Set();
  const servers = c.servers.map((s, i) => {
    const w = `servers[${i}]`;
    req(s && typeof s === 'object', `${w} must be an object`);
    req(typeof s.name === 'string' && SERVER_NAME_RE.test(s.name), `${w}.name must match ${SERVER_NAME_RE}`);
    req(!names.has(s.name), `${w}.name "${s.name}" is duplicated`);
    names.add(s.name);
    req(typeof s.host === 'string' && s.host, `${w}.host is required`);
    req(typeof s.user === 'string' && s.user, `${w}.user is required`);
    req(typeof s.password === 'string', `${w}.password is required (use "env:VAR")`);
    req(Array.isArray(s.databases) && s.databases.length > 0, `${w}.databases must be a non-empty array`);
    for (const db of s.databases) {
      req(typeof db === 'string' && DB_NAME_RE.test(db), `${w}.databases: invalid database name ${JSON.stringify(db)}`);
    }
    req(new Set(s.databases).size === s.databases.length, `${w}.databases contains duplicates`);
    req(typeof s.backupDir === 'string' && s.backupDir, `${w}.backupDir is required (path as SQL Server sees it)`);
    const port = s.port ?? 1433;
    req(isPosInt(port) && port < 65536, `${w}.port must be a valid TCP port`);
    const requestTimeoutMs = s.requestTimeoutMs ?? 6 * 60 * 60 * 1000;
    req(Number.isInteger(requestTimeoutMs) && requestTimeoutMs >= 0, `${w}.requestTimeoutMs must be >= 0`);
    return {
      name: s.name,
      host: s.host,
      port,
      user: s.user,
      password: s.password,
      instanceName: s.instanceName,
      encrypt: bool(s.encrypt, `${w}.encrypt`, true),
      trustServerCertificate: bool(s.trustServerCertificate, `${w}.trustServerCertificate`, false),
      databases: [...s.databases],
      backupDir: s.backupDir,
      localBackupDir: path.resolve(expandHome(s.localBackupDir || s.backupDir)),
      nativeCompression: bool(s.nativeCompression, `${w}.nativeCompression`, false),
      requestTimeoutMs,
    };
  });

  // retention
  const r = c.retention ?? {};
  req(r.keepLast === undefined || isPosInt(r.keepLast), 'retention.keepLast must be a positive integer');
  req(r.keepDays === undefined || isPosInt(r.keepDays), 'retention.keepDays must be a positive integer');
  const retention = { keepLast: r.keepLast, keepDays: r.keepDays };

  // encryption
  const e = c.encryption ?? {};
  const encryption = { enabled: bool(e.enabled, 'encryption.enabled', false), keyEnv: e.keyEnv || 'BACKUP_ENCRYPTION_KEY' };
  if (encryption.enabled) {
    encryption.key = parseEncryptionKey(env[encryption.keyEnv], encryption.keyEnv);
  }

  // schedule
  let schedule;
  if (c.schedule !== undefined) {
    req(c.schedule && typeof c.schedule.cron === 'string' && c.schedule.cron.trim(), 'schedule.cron is required');
    schedule = { cron: c.schedule.cron, timezone: c.schedule.timezone };
  }

  return {
    google,
    drive: { rootFolder: rootFolder.trim() },
    servers,
    retention,
    compression: bool(c.compression, 'compression', true),
    encryption,
    workDir: path.resolve(expandHome(c.workDir || path.join(os.tmpdir(), 'backup-manager'))),
    schedule,
  };
}

/** Accepts a 32-byte key encoded as base64 or 64 hex characters. */
export function parseEncryptionKey(value, envName = 'BACKUP_ENCRYPTION_KEY') {
  if (!value) throw new ConfigError(`encryption is enabled but ${envName} is not set`);
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(value)) key = Buffer.from(value, 'hex');
  else key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new ConfigError(`${envName} must be a 32-byte key (base64 or hex)`);
  return key;
}

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH, opts = {}) {
  let text;
  try {
    text = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read config file ${configPath}: ${err.code || err.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`config file ${configPath} is not valid JSON: ${err.message}`);
  }
  return normalizeConfig(raw, opts);
}
