// Orchestration: backup -> verify -> pack -> upload -> retention, plus list/download.
// All I/O collaborators are injected so this module is testable without SQL Server or Drive.

import fs from 'node:fs/promises';
import path from 'node:path';
import { artifactName, backupBaseName, joinServerPath, parseArtifactName } from './naming.js';
import { selectForDeletion } from './retention.js';
import { hashFile, packFile, unpackFile } from './transform.js';

/** Pick the (server, db) pairs to back up given optional filters. */
export function selectTargets(config, { server, db } = {}) {
  const targets = [];
  for (const s of config.servers) {
    if (server && s.name !== server) continue;
    for (const d of s.databases) {
      if (db && d !== db) continue;
      targets.push({ server: s, db: d });
    }
  }
  if (targets.length === 0) {
    const what = [server && `server "${server}"`, db && `database "${db}"`].filter(Boolean).join(' / ');
    throw new Error(`no configured database matches ${what || 'the selection'}`);
  }
  return targets;
}

async function rmQuiet(file, logger) {
  if (!file) return;
  try {
    await fs.rm(file, { force: true });
  } catch (err) {
    logger.warn('could not remove local file', { file, error: err });
  }
}

/**
 * Back up one database end to end. Throws on failure; always cleans local files.
 */
export async function backupOne({ config, server, db, sqlClient, drive, logger, now = () => new Date() }) {
  const started = Date.now();
  const base = backupBaseName(db, now());
  const serverPath = joinServerPath(server.backupDir, base);
  const localBak = path.join(server.localBackupDir, base);
  const compressed = config.compression;
  const encrypted = config.encryption.enabled;
  const name = artifactName(base, { compressed, encrypted });
  const packed = compressed || encrypted ? path.join(config.workDir, name) : null;
  const log = { server: server.name, db };

  try {
    await sqlClient.assertDatabaseOnline(db);
    logger.info('backup started', { ...log, serverPath });
    await sqlClient.backup(db, serverPath);
    await sqlClient.verify(serverPath);
    logger.info('backup verified', { ...log });

    try {
      await fs.access(localBak);
    } catch {
      throw new Error(
        `backup file not found at ${localBak}; SQL Server must run on this machine and SQL_BACKUP_DIR (localBackupDir) must be the folder it writes backups to`,
      );
    }

    let upload;
    if (packed) {
      await fs.mkdir(config.workDir, { recursive: true, mode: 0o700 });
      upload = { file: packed, ...(await packFile(localBak, packed, { compress: compressed, key: config.encryption.key })) };
    } else {
      upload = { file: localBak, ...(await hashFile(localBak)) };
    }
    // The .bak is no longer needed once packed.
    if (packed) await rmQuiet(localBak, logger);

    const folderId = await drive.ensurePath([config.drive.rootFolder, server.name, db]);
    const file = await drive.uploadResumable({
      filePath: upload.file,
      name,
      parentId: folderId,
      appProperties: { sha256: upload.sha256, compressed: compressed ? '1' : '0', encrypted: encrypted ? '1' : '0' },
    });
    if (file.md5Checksum && file.md5Checksum !== upload.md5) {
      await drive.deleteFile(file.id).catch(() => {});
      throw new Error('uploaded file checksum mismatch; the corrupt upload was deleted');
    }
    if (file.size !== undefined && Number(file.size) !== upload.size) {
      await drive.deleteFile(file.id).catch(() => {});
      throw new Error(`uploaded size ${file.size} != local size ${upload.size}; the corrupt upload was deleted`);
    }
    logger.info('upload complete', { ...log, fileId: file.id, name, bytes: upload.size });

    const result = { ...log, ok: true, fileId: file.id, name, bytes: upload.size, deleted: 0 };
    try {
      result.deleted = await applyRetention({ drive, folderId, retention: config.retention, logger, log, now });
    } catch (err) {
      // The backup itself is safe on Drive; don't report it as failed.
      logger.warn('retention failed; old backups were not pruned', { ...log, error: err });
      result.retentionError = err.message;
    }
    result.durationMs = Date.now() - started;
    return result;
  } finally {
    await rmQuiet(packed, logger);
    await rmQuiet(localBak, logger);
  }
}

export async function applyRetention({ drive, folderId, retention, logger, log = {}, now = () => new Date() }) {
  if (!retention.keepLast && !retention.keepDays) return 0;
  const files = await drive.listBackups(folderId);
  const doomed = selectForDeletion(files, retention, now());
  let deleted = 0;
  for (const f of doomed) {
    try {
      await drive.deleteFile(f.id);
      deleted++;
      logger.info('retention: deleted old backup', { ...log, fileId: f.id, name: f.name, createdTime: f.createdTime });
    } catch (err) {
      logger.warn('retention: could not delete old backup', { ...log, fileId: f.id, error: err });
    }
  }
  return deleted;
}

/**
 * Run all selected backups. A failure on one database never stops the others.
 * @returns {Promise<{results: object[], failed: number}>}
 */
export async function runBackups({ config, drive, createSqlClient, logger, filter = {}, now }) {
  const targets = selectTargets(config, filter);
  const results = [];
  const byServer = new Map();
  for (const t of targets) {
    if (!byServer.has(t.server)) byServer.set(t.server, []);
    byServer.get(t.server).push(t.db);
  }

  for (const [server, dbs] of byServer) {
    let sqlClient;
    try {
      sqlClient = createSqlClient(server);
      await sqlClient.connect();
    } catch (err) {
      logger.error('cannot connect to SQL Server', { server: server.name, error: err });
      for (const db of dbs) results.push({ server: server.name, db, ok: false, error: `connect failed: ${err.message}` });
      await sqlClient?.close().catch(() => {});
      continue;
    }
    try {
      for (const db of dbs) {
        try {
          results.push(await backupOne({ config, server, db, sqlClient, drive, logger, now }));
        } catch (err) {
          logger.error('backup failed', { server: server.name, db, error: err });
          results.push({ server: server.name, db, ok: false, error: err.message });
        }
      }
    } finally {
      await sqlClient.close().catch((err) => logger.warn('error closing SQL connection', { error: err }));
    }
  }
  return { results, failed: results.filter((r) => !r.ok).length };
}

/** List backups on Drive, grouped by server/db. */
export async function listBackups({ config, drive, filter = {} }) {
  const rootId = await drive.resolvePath([config.drive.rootFolder]);
  if (!rootId) return [];
  const out = [];
  const serverFolders = await drive.listSubfolders(rootId);
  for (const sf of serverFolders) {
    if (filter.server && sf.name !== filter.server) continue;
    for (const dbf of await drive.listSubfolders(sf.id)) {
      if (filter.db && dbf.name !== filter.db) continue;
      for (const f of await drive.listBackups(dbf.id)) {
        out.push({ server: sf.name, db: dbf.name, id: f.id, name: f.name, size: Number(f.size), createdTime: f.createdTime });
      }
    }
  }
  return out.sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));
}

/**
 * Download a backup and restore it to a plain .bak file (decrypt + decompress + verify).
 * `fileId` or `latest` + `db` (and optionally `server`) selects the file.
 */
export async function downloadBackup({ config, drive, logger, fileId, latest, filter = {}, outDir = '.', force = false }) {
  let meta;
  if (latest) {
    if (!filter.db) throw new Error('--db is required with "latest"');
    const all = await listBackups({ config, drive, filter });
    if (all.length === 0) throw new Error(`no backups found for database "${filter.db}"`);
    const servers = new Set(all.map((b) => b.server));
    if (servers.size > 1) throw new Error(`database "${filter.db}" exists on several servers; add --server`);
    fileId = all[0].id;
  }
  meta = await drive.getFile(fileId);
  if (meta.appProperties?.bmApp !== 'backup-manager') throw new Error(`file ${fileId} is not a backup-manager backup`);

  const { baseName } = parseArtifactName(meta.name);
  const compressed = meta.appProperties.compressed === '1';
  const encrypted = meta.appProperties.encrypted === '1';
  const key = encrypted ? config.encryption.key : undefined;
  if (encrypted && !key) throw new Error(`backup is encrypted: set ${config.encryption.keyEnv} and encryption.enabled`);

  const fileName = path.basename(baseName);
  if (!/^[A-Za-z0-9._-]+\.bak$/.test(fileName) || fileName.startsWith('.')) {
    throw new Error(`refusing unsafe backup file name from Drive: ${JSON.stringify(meta.name)}`);
  }
  await fs.mkdir(outDir, { recursive: true });
  const dest = path.resolve(outDir, fileName);
  if (!force) {
    const exists = await fs.access(dest).then(() => true, () => false);
    if (exists) throw new Error(`${dest} already exists (use --force to overwrite)`);
  }
  const tmp = `${dest}.download`;
  try {
    await drive.download(fileId, tmp);
    const { sha256 } = await hashFile(tmp);
    if (meta.appProperties.sha256 && sha256 !== meta.appProperties.sha256) {
      throw new Error('downloaded file checksum mismatch');
    }
    if (compressed || encrypted) {
      const partial = `${dest}.partial`;
      try {
        await unpackFile(tmp, partial, { compressed, encrypted, key });
        await fs.rename(partial, dest);
      } finally {
        await rmQuiet(partial, logger);
      }
    } else {
      await fs.rename(tmp, dest);
    }
    logger.info('download complete', { fileId, dest });
    return { fileId, dest };
  } finally {
    await rmQuiet(tmp, logger);
  }
}
