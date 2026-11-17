// Native SQL Server backup via the mssql (tedious) driver.
// Database name and path are passed as T-SQL variables, never concatenated.

import sql from 'mssql';

export function buildBackupSql({ nativeCompression = false } = {}) {
  const opts = ['CHECKSUM', 'COPY_ONLY', 'INIT', 'FORMAT', 'STATS = 10'];
  if (nativeCompression) opts.push('COMPRESSION');
  return `BACKUP DATABASE @db TO DISK = @path WITH ${opts.join(', ')};`;
}

export function buildVerifySql() {
  return 'RESTORE VERIFYONLY FROM DISK = @path WITH CHECKSUM;';
}

export const DB_EXISTS_SQL = 'SELECT state_desc FROM sys.databases WHERE name = @db;';

export const BACKUP_PERMISSION_SQL = "SELECT HAS_PERMS_BY_NAME(@db, 'DATABASE', 'BACKUP DATABASE') AS can_backup;";

// RESTORE VERIFYONLY needs CREATE DATABASE permission in master (db_backupoperator is not enough).
export const VERIFY_PERMISSION_SQL = "SELECT HAS_PERMS_BY_NAME('master', 'DATABASE', 'CREATE DATABASE') AS can_verify;";

export const SERVER_INFO_SQL = `SELECT CAST(SERVERPROPERTY('ProductMajorVersion') AS int) AS major,
  CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS version,
  CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS edition;`;

/** The server messages of a SQL error, oldest first (mssql puts the earlier ones in err.precedingErrors). */
function sqlErrorChain(err) {
  const preceding = Array.isArray(err?.precedingErrors) ? err.precedingErrors : [];
  return [...preceding, err].filter(Boolean);
}

/** Every SQL Server error number in the chain, e.g. [262, 3013]. */
export function sqlErrorNumbers(err) {
  return sqlErrorChain(err).map((e) => e.number).filter((n) => Number.isInteger(n));
}

/**
 * One line with every server message, in order:
 * "Msg 262: CREATE DATABASE permission denied in database 'master'. | Msg 3013: VERIFY DATABASE is terminating abnormally."
 * Errors without a SQL number (network, settings) keep their plain message.
 */
export function formatSqlError(err) {
  return sqlErrorChain(err)
    .map((e) => {
      const msg = String(e?.message ?? e);
      return Number.isInteger(e?.number) ? `Msg ${e.number}: ${msg}` : msg;
    })
    .join(' | ');
}

/** SQL Server 2016 is major version 13. */
export const MIN_SQL_MAJOR = 13;

export function toPoolConfig(server) {
  return {
    server: server.host,
    port: server.instanceName ? undefined : server.port,
    user: server.user,
    password: server.password,
    requestTimeout: server.requestTimeoutMs,
    connectionTimeout: 30_000,
    pool: { max: 1, min: 0 },
    options: {
      encrypt: server.encrypt,
      trustServerCertificate: server.trustServerCertificate,
      instanceName: server.instanceName,
      appName: 'backup-manager',
    },
  };
}

/** Thin wrapper so the orchestrator can be tested with a fake. */
export class MssqlClient {
  constructor(server, { driver = sql } = {}) {
    this.server = server;
    this.driver = driver;
    this.pool = null;
  }

  async connect() {
    if (!this.pool) {
      this.pool = new this.driver.ConnectionPool(toPoolConfig(this.server));
      await this.pool.connect();
    }
    return this;
  }

  async close() {
    if (this.pool) {
      const p = this.pool;
      this.pool = null;
      await p.close();
    }
  }

  async assertDatabaseOnline(db) {
    const r = await this.pool.request().input('db', this.driver.NVarChar(128), db).query(DB_EXISTS_SQL);
    const row = r.recordset?.[0];
    if (!row) throw new Error(`database "${db}" does not exist`);
    if (row.state_desc !== 'ONLINE') throw new Error(`database "${db}" is ${row.state_desc}, not ONLINE`);
  }

  /** True if the login may run BACKUP DATABASE on db. */
  async canBackup(db) {
    const r = await this.pool.request().input('db', this.driver.NVarChar(128), db).query(BACKUP_PERMISSION_SQL);
    return r.recordset?.[0]?.can_backup === 1;
  }

  /** True if the login may run RESTORE VERIFYONLY (CREATE DATABASE in master). Once per server. */
  async canVerify() {
    const r = await this.pool.request().query(VERIFY_PERMISSION_SQL);
    return r.recordset?.[0]?.can_verify === 1;
  }

  /** { major, version, edition } */
  async serverInfo() {
    const r = await this.pool.request().query(SERVER_INFO_SQL);
    return r.recordset?.[0] ?? {};
  }

  async backup(db, serverPath) {
    await this.pool
      .request()
      .input('db', this.driver.NVarChar(128), db)
      .input('path', this.driver.NVarChar(4000), serverPath)
      .query(buildBackupSql(this.server));
  }

  async verify(serverPath) {
    await this.pool.request().input('path', this.driver.NVarChar(4000), serverPath).query(buildVerifySql());
  }
}
