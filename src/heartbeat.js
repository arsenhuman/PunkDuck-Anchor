// Healthchecks.io heartbeat ("dead man's switch").
//
// After a run where EVERY selected database succeeded, we POST a short summary to the
// configured ping URL. Any failure => no ping. Healthchecks.io alerts when pings stop
// (configure Period = 1 day, Grace = 4 days => alert after 5 days of silence).
//
// The ping is best-effort: it never throws and never changes the backup result.

import { fmtBytes } from './format.js';

const MAX_BODY = 10_000; // Healthchecks.io stores up to 100 kB; keep it small

/** Plain-text summary of a fully successful run. Contains no secrets. */
export function buildSummary(results) {
  const ok = results.filter((r) => r.ok);
  const lines = [
    `${ok.length}/${results.length} OK`,
    ...ok.map((r) => `${r.server}/${r.db}  ${r.name}  ${fmtBytes(r.bytes)}${r.retentionError ? '  (retention failed)' : ''}`),
  ];
  const text = lines.join('\n');
  return text.length > MAX_BODY ? text.slice(0, MAX_BODY - 15) + '\n…(truncated)' : text;
}

/** For logs: show only the host, the UUID in the path is effectively a secret. */
function safeTarget(url) {
  try {
    return new URL(url).host;
  } catch {
    return '(invalid url)';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
export async function sendHeartbeat({
  url,
  results,
  failed,
  logger,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
  attempts = 3,
  retryDelayMs = 2_000,
}) {
  if (!url) return { sent: false, reason: 'disabled' };
  if (!results?.length) {
    logger.warn('heartbeat not sent because no database was backed up');
    return { sent: false, reason: 'empty' };
  }
  if (failed > 0) {
    logger.warn('heartbeat not sent because the run had failures', { failed, total: results.length });
    return { sent: false, reason: 'failures' };
  }

  const body = buildSummary(results);
  const target = safeTarget(url);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'User-Agent': 'backup-manager' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      await Promise.resolve(res.body?.cancel?.()).catch(() => {}); // free the connection; we don't need the body
      if (res.ok) {
        logger.info('heartbeat sent', { target });
        return { sent: true };
      }
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        // e.g. 404 = unknown check UUID: retrying will not help
        logger.warn('heartbeat rejected; check HEALTHCHECK_URL', { target, status: res.status });
        return { sent: false, reason: `http ${res.status}` };
      }
      logger.warn('heartbeat attempt failed', { target, attempt, status: res.status });
    } catch (err) {
      logger.warn('heartbeat attempt failed', { target, attempt, error: err?.name === 'TimeoutError' ? 'timeout' : err?.message });
    }
    if (attempt < attempts) await sleep(retryDelayMs * attempt);
  }
  logger.warn('heartbeat could not be delivered; backups themselves are unaffected', { target });
  return { sent: false, reason: 'unreachable' };
}
