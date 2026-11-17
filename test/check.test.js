import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { explainSqlError, formatChecks, runChecks } from '../src/check.js';
import { tmpDir } from './helpers.js';

async function setup({ server = {}, ...over } = {}) {
  const dir = await tmpDir();
  const backupDir = path.join(dir, 'bak');
  await fs.mkdir(backupDir);
  return {
    envFile: path.join(dir, 'backup-manager.env'),
    servers: [{ name: 's', host: 'localhost', port: 1433, user: 'backup_user', databases: ['Sales', 'HR'], localBackupDir: backupDir, ...server }],
    workDir: path.join(dir, 'work'),
    google: { tokenFile: path.join(dir, 'token.json') },
    googleEmail: 'client@gmail.com',
    monitoring: { heartbeatUrl: 'https://hc-ping.com/abc' },
    ...over,
  };
}

function fakeSql({ connectError, info = { major: 16, version: '16.0.1000.6', edition: 'Express Edition (64-bit)' }, dbs = { Sales: 'ONLINE', HR: 'ONLINE' }, perms = { Sales: true, HR: true } } = {}) {
  const calls = { closed: 0 };
  return {
    calls,
    create: () => ({
      async connect() { if (connectError) throw connectError; },
      async close() { calls.closed++; },
      async serverInfo() { return info; },
      async assertDatabaseOnline(db) {
        if (!dbs[db]) throw new Error(`database "${db}" does not exist`);
        if (dbs[db] !== 'ONLINE') throw new Error(`database "${db}" is ${dbs[db]}, not ONLINE`);
      },
      async canBackup(db) { return perms[db]; },
    }),
  };
}

const signedIn = async () => ({ loggedIn: true, email: 'Client@gmail.com' });

test('all checks pass on a healthy setup', async () => {
  const config = await setup();
  const sql = fakeSql();
  const r = await runChecks({ loadConfig: async () => config, createSqlClient: sql.create, authStatus: signedIn });
  assert.equal(r.ok, true, formatChecks(r.checks));
  assert.deepEqual(r.checks.map((c) => c.name), ['Settings', 'SQL connection', 'Database Sales', 'Database HR', 'Backup folder', 'Work folder', 'Google account', 'Healthchecks']);
  assert.match(formatChecks(r.checks), /\[ OK \] SQL connection: localhost:1433 \(Express Edition \(64-bit\) 16\.0\.1000\.6\)/);
  assert.match(formatChecks(r.checks), /signed in as Client@gmail.com/);
  assert.equal(sql.calls.closed, 1);
  assert.deepEqual(await fs.readdir(config.servers[0].localBackupDir), [], 'probe file removed');
});

test('invalid settings stop early and name the key', async () => {
  const r = await runChecks({
    loadConfig: async () => { throw new Error('SQL_DATABASES is empty'); },
    createSqlClient: () => assert.fail('must not connect'),
    authStatus: signedIn,
    envFile: 'C:\\ProgramData\\backup-manager\\backup-manager.env',
  });
  assert.equal(r.ok, false);
  assert.equal(r.checks.length, 1);
  assert.match(formatChecks(r.checks), /\[FAIL\] Settings: SQL_DATABASES is empty\n\s+Fix: Edit C:\\ProgramData/);
});

test('database problems: missing, offline, no BACKUP permission', async () => {
  const config = await setup({ server: { databases: ['Sales', 'HR', 'Gone', 'Old'] } });
  const sql = fakeSql({ dbs: { Sales: 'ONLINE', HR: 'ONLINE', Old: 'OFFLINE' }, perms: { Sales: true, HR: false } });
  const r = await runChecks({ loadConfig: async () => config, createSqlClient: sql.create, authStatus: signedIn });
  assert.equal(r.ok, false);
  const byName = Object.fromEntries(r.checks.map((c) => [c.name, c]));
  assert.equal(byName['Database Sales'].ok, true);
  assert.match(byName['Database HR'].detail, /no BACKUP DATABASE permission/);
  assert.match(byName['Database HR'].fix, /db_backupoperator/);
  assert.match(byName['Database Gone'].detail, /does not exist/);
  assert.match(byName['Database Old'].detail, /OFFLINE/);
});

test('SQL connection failure skips the database checks and explains the fix', async () => {
  const config = await setup();
  const err = Object.assign(new Error('Failed to connect to localhost:1433 - connect ECONNREFUSED 127.0.0.1:1433'), { code: 'ESOCKET' });
  const r = await runChecks({ loadConfig: async () => config, createSqlClient: fakeSql({ connectError: err }).create, authStatus: signedIn });
  assert.equal(r.ok, false);
  const text = formatChecks(r.checks);
  assert.match(text, /\[FAIL\] SQL connection: .*TCP\/IP is probably disabled/);
  assert.match(text, /SQL Server Configuration Manager/);
  assert.match(text, /\[ -- \] Database Sales: skipped/);
});

test('SQL Server older than 2016 fails', async () => {
  const config = await setup();
  const r = await runChecks({ loadConfig: async () => config, createSqlClient: fakeSql({ info: { major: 12, version: '12.0', edition: 'Express' } }).create, authStatus: signedIn });
  assert.equal(r.ok, false);
  assert.match(formatChecks(r.checks), /older than SQL Server 2016/);
});

test('backup folder missing', async () => {
  const config = await setup({ server: { localBackupDir: '/definitely/not/here' } });
  const r = await runChecks({ loadConfig: async () => config, createSqlClient: fakeSql().create, authStatus: signedIn });
  assert.equal(r.ok, false);
  assert.match(formatChecks(r.checks), /\[FAIL\] Backup folder: SQL_BACKUP_DIR .* does not exist/);
});

test('Google: not signed in, wrong account, broken token, skipped', async () => {
  const config = await setup();
  const run = (authStatus, skipAuth) => runChecks({ loadConfig: async () => config, createSqlClient: fakeSql().create, authStatus, skipAuth });
  let r = await run(async () => ({ loggedIn: false }));
  assert.match(formatChecks(r.checks), /\[FAIL\] Google account: not signed in[\s\S]*auth login/);
  r = await run(async () => ({ loggedIn: true, email: 'other@gmail.com' }));
  assert.match(formatChecks(r.checks), /signed in as other@gmail.com, but GOOGLE_EMAIL is client@gmail.com/);
  r = await run(async () => { throw new Error('invalid_grant'); });
  assert.match(formatChecks(r.checks), /does not work: invalid_grant[\s\S]*revoked/);
  r = await run(() => assert.fail('must not be called'), true);
  assert.equal(r.ok, true);
  assert.match(formatChecks(r.checks), /\[ -- \] Google account: skipped/);
});

test('monitoring off is reported but not a failure', async () => {
  const config = await setup({ monitoring: {} });
  const r = await runChecks({ loadConfig: async () => config, createSqlClient: fakeSql().create, authStatus: signedIn });
  assert.equal(r.ok, true);
  assert.match(formatChecks(r.checks), /HEALTHCHECK_URL not set: monitoring is off/);
});

test('explainSqlError recognizes the SQL Express traps', () => {
  const srv = { host: 'localhost', port: 1433, instanceName: 'SQLEXPRESS', user: 'bu' };
  const e = (message, code) => explainSqlError(Object.assign(new Error(message), { code }), srv);
  assert.match(e('Failed to get response from SQL Server Browser on localhost', 'EINSTLOOKUP').problem, /SQL Server Browser service is probably stopped/);
  assert.match(e('Port for SQLEXPRESS not found in localhost', 'EINSTLOOKUP').fix, /SQL_PORT/);
  const login = e("Login failed for user 'bu'.", 'ELOGIN');
  assert.match(login.problem, /refused the login for SQL_USER "bu"/);
  assert.match(login.fix, /SQL Server and Windows Authentication mode/);
  assert.match(e('Failed to connect to localhost:1433 in 15000ms', 'ETIMEOUT').problem, /TCP\/IP is probably disabled/);
  assert.match(e('self-signed certificate in certificate chain', 'ESOCKET').fix, /SQL_TRUST_SERVER_CERTIFICATE=true/);
  assert.match(e('getaddrinfo ENOTFOUND sqlbox', 'ESOCKET').problem, /SQL_HOST/);
  assert.match(e('something odd').problem, /SQL Server error: something odd/);
});
