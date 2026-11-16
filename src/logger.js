// Structured JSON-lines logger that never prints secrets.

const SECRET_KEY = /pass(word)?|secret|token|authorization|api[-_]?key|encryption[-_]?key|^key$/i;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function redact(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), code: value.code };
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

export function createLogger({ level = process.env.LOG_LEVEL || 'info', stream = process.stderr } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const log = (lvl, msg, fields = {}) => {
    if (LEVELS[lvl] < min) return;
    const entry = { ts: new Date().toISOString(), level: lvl, msg: redactString(msg), ...redact(fields) };
    stream.write(JSON.stringify(entry) + '\n');
  };
  return {
    debug: (m, f) => log('debug', m, f),
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
  };
}

export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
