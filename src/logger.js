// Structured JSON-lines logger that never prints secrets.
// Lines go to stderr and, when logDir is set, are appended to logDir/backup-YYYY-MM-DD.log.

import fs from 'node:fs';
import path from 'node:path';
import { formatSqlError } from './mssql.js';

const SECRET_KEY = /pass(word)?|secret|token|authorization|api[-_]?key|encryption[-_]?key|^key$/i;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function redact(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    // formatSqlError adds SQL Server's earlier messages (err.precedingErrors), e.g. the 262 behind a 3013.
    return { name: value.name, message: redactString(formatSqlError(value)), code: value.code };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

// Strip bearer tokens / OAuth codes that may leak into error messages.
function redactString(s) {
  return String(s)
    .replace(/(Bearer\s+)[\w.\-~+/]+=*/gi, '$1[REDACTED]')
    .replace(/((?:access_token|refresh_token|code|client_secret)=)[^&\s]+/gi, '$1[REDACTED]');
}

const LOG_FILE_RE = /^backup-(\d{4}-\d{2}-\d{2})\.log$/;
const pad = (n) => String(n).padStart(2, '0');

/** Local calendar date, as the technician reads it: 2026-11-17. */
export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function logFileFor(logDir, d = new Date()) {
  return path.join(logDir, `backup-${localDate(d)}.log`);
}

/** Delete backup-YYYY-MM-DD.log files older than keepDays. Returns the deleted names. Never throws. */
export function cleanupLogs(logDir, { keepDays = 30, now = new Date() } = {}) {
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - keepDays);
  const deleted = [];
  let names;
  try {
    names = fs.readdirSync(logDir);
  } catch {
    return deleted;
  }
  for (const name of names) {
    const m = LOG_FILE_RE.exec(name);
    if (!m) continue;
    const [y, mo, d] = m[1].split('-').map(Number);
    if (new Date(y, mo - 1, d) < cutoff) {
      try {
        fs.rmSync(path.join(logDir, name), { force: true });
        deleted.push(name);
      } catch {
        // locked or no permission: try again next run
      }
    }
  }
  return deleted;
}

export function createLogger({ level = process.env.LOG_LEVEL || 'info', stream = process.stderr, logDir, now = () => new Date() } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  let fileOk = Boolean(logDir);
  if (fileOk) {
    try {
      fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      fileOk = false;
      stream.write(`warning: cannot create log folder ${logDir}: ${err.code || err.message}; logging to the console only\n`);
    }
  }
  const log = (lvl, msg, fields = {}) => {
    if (LEVELS[lvl] < min) return;
    const ts = now();
    const line = JSON.stringify({ ts: ts.toISOString(), level: lvl, msg: redactString(msg), ...redact(fields) }) + '\n';
    stream.write(line);
    if (fileOk) {
      try {
        fs.appendFileSync(logFileFor(logDir, ts), line, { mode: 0o600 });
      } catch (err) {
        fileOk = false;
        stream.write(`warning: cannot write log file in ${logDir}: ${err.code || err.message}; logging to the console only\n`);
      }
    }
  };
  return {
    debug: (m, f) => log('debug', m, f),
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
  };
}

export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
