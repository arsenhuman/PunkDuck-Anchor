// File-naming helpers shared by backup and download.

export function timestampUtc(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); // 20261116T020000Z
}

export function sanitizeForFile(name) {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
}

export function backupBaseName(db, date = new Date()) {
  return `${sanitizeForFile(db)}_${timestampUtc(date)}.bak`;
}

/** Join a directory as SQL Server sees it (Windows or Linux) with a file name. */
export function joinServerPath(dir, file) {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith(sep) ? dir + file : dir + sep + file;
}

export function artifactName(baseName, { compressed, encrypted }) {
  return baseName + (compressed ? '.gz' : '') + (encrypted ? '.enc' : '');
}

/** Inverse of artifactName: what transformations must be undone. */
export function parseArtifactName(name) {
  let rest = name;
  const encrypted = rest.endsWith('.enc');
  if (encrypted) rest = rest.slice(0, -4);
  const compressed = rest.endsWith('.gz');
  if (compressed) rest = rest.slice(0, -3);
  return { baseName: rest, compressed, encrypted };
}
