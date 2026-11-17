import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBackupSql, buildVerifySql, formatSqlError, MssqlClient, sqlErrorNumbers, toPoolConfig, VERIFY_PERMISSION_SQL } from '../src/mssql.js';

test('backup SQL is parameterized and uses safe options', () => {
  const s = buildBackupSql();
  assert.equal(s, 'BACKUP DATABASE @db TO DISK = @path WITH CHECKSUM, COPY_ONLY, INIT, FORMAT, STATS = 10;');
  assert.match(buildBackupSql({ nativeCompression: true }), /, COMPRESSION;$/);
  assert.equal(buildVerifySql(), 'RESTORE VERIFYONLY FROM DISK = @path WITH CHECKSUM;');
});

test('pool config maps server settings', () => {
  const p = toPoolConfig({ host: 'h', port: 1500, user: 'u', password: 'p', requestTimeoutMs: 0, encrypt: true, trustServerCertificate: false });
  assert.equal(p.server, 'h');
  assert.equal(p.port, 1500);
  assert.equal(p.requestTimeout, 0);
  assert.equal(p.options.encrypt, true);
  assert.equal(toPoolConfig({ host: 'h', port: 1433, instanceName: 'SQLEXPRESS' }).port, undefined);
});

function fakeDriver(rows) {
  const calls = [];
  class ConnectionPool {
    constructor(cfg) { this.cfg = cfg; }
    async connect() {}
    async close() { calls.push({ closed: true }); }
    request() {
      const inputs = {};
      const r = {
        input(name, type, value) { inputs[name] = { type, value }; return r; },
        async query(text) { calls.push({ text, inputs }); return { recordset: rows }; },
      };
      return r;
    }
  }
  return { calls, driver: { ConnectionPool, NVarChar: (n) => `nvarchar(${n})` } };
}

test('client passes db name and path as typed parameters, never inline', async () => {
  const { calls, driver } = fakeDriver([{ state_desc: 'ONLINE' }]);
  const evil = "x]; DROP DATABASE prod; --'";
  const c = await new MssqlClient({ host: 'h', nativeCompression: false }, { driver }).connect();
  await c.assertDatabaseOnline(evil);
  await c.backup(evil, "/b/it's.bak");
  await c.verify("/b/it's.bak");
  await c.close();
  for (const call of calls.filter((x) => x.text)) {
    assert.ok(!call.text.includes('DROP'), 'SQL text must not contain user input');
  }
  assert.deepEqual(calls[1].inputs.db, { type: 'nvarchar(128)', value: evil });
  assert.deepEqual(calls[1].inputs.path, { type: 'nvarchar(4000)', value: "/b/it's.bak" });
  assert.ok(calls.at(-1).closed);
});

test('assertDatabaseOnline rejects missing or offline databases', async () => {
  let c = await new MssqlClient({ host: 'h' }, { driver: fakeDriver([]).driver }).connect();
  await assert.rejects(c.assertDatabaseOnline('nope'), /does not exist/);
  c = await new MssqlClient({ host: 'h' }, { driver: fakeDriver([{ state_desc: 'RESTORING' }]).driver }).connect();
  await assert.rejects(c.assertDatabaseOnline('x'), /RESTORING/);
});

test('formatSqlError lists the preceding server messages in order', () => {
  const e262 = Object.assign(new Error("CREATE DATABASE permission denied in database 'master'."), { number: 262 });
  const e3013 = Object.assign(new Error('VERIFY DATABASE is terminating abnormally.'), { number: 3013, precedingErrors: [e262] });
  assert.equal(formatSqlError(e3013),
    "Msg 262: CREATE DATABASE permission denied in database 'master'. | Msg 3013: VERIFY DATABASE is terminating abnormally.");
  assert.deepEqual(sqlErrorNumbers(e3013), [262, 3013]);
  assert.equal(formatSqlError(e262), "Msg 262: CREATE DATABASE permission denied in database 'master'.");
  assert.equal(formatSqlError(Object.assign(new Error('x'), { precedingErrors: [] })), 'x');
  assert.equal(formatSqlError(new Error('connect ECONNREFUSED 127.0.0.1:1433')), 'connect ECONNREFUSED 127.0.0.1:1433');
  assert.deepEqual(sqlErrorNumbers(new Error('plain')), []);
});

test('canVerify asks for CREATE DATABASE in master with a constant query', async () => {
  const { calls, driver } = fakeDriver([{ can_verify: 1 }]);
  const c = await new MssqlClient({ host: 'h' }, { driver }).connect();
  assert.equal(await c.canVerify(), true);
  assert.equal(calls[0].text, VERIFY_PERMISSION_SQL);
  assert.match(VERIFY_PERMISSION_SQL, /HAS_PERMS_BY_NAME\('master', 'DATABASE', 'CREATE DATABASE'\)/);
  const no = await new MssqlClient({ host: 'h' }, { driver: fakeDriver([{ can_verify: 0 }]).driver }).connect();
  assert.equal(await no.canVerify(), false);
});
