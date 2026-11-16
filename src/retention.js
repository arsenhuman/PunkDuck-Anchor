// Retention policy.
//
// A backup is KEPT if it satisfies ANY configured rule:
//   - it is among the newest `keepLast` backups, or
//   - it is younger than `keepDays` days.
// The newest backup is always kept. With no rules configured nothing is deleted.

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {{id:string, createdTime:string|Date}[]} files backups of ONE database
 * @returns the files that should be deleted
 */
export function selectForDeletion(files, { keepLast, keepDays } = {}, now = new Date()) {
  if (!keepLast && !keepDays) return [];
  const sorted = [...files].sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));
  const cutoff = keepDays ? now.getTime() - keepDays * DAY_MS : null;
  return sorted.filter((f, idx) => {
    if (idx === 0) return false; // never delete the newest
    if (keepLast && idx < keepLast) return false;
    if (cutoff !== null && new Date(f.createdTime).getTime() >= cutoff) return false;
    return true;
  });
}
