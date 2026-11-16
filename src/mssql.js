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
