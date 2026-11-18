import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ConfigError } from '../src/config.js';
import { defaultServerName, envToConfig, isLocalSqlHost, loadEnvConfig, loadOAuthClient, parseEnvText } from '../src/envconfig.js';
import { appHome, appPaths } from '../src/paths.js';
import { tmpDir } from './helpers.js';

const KEY = Buffer.alloc(32, 9).toString('base64');
const GOOGLE = { clientId: 'cid', clientSecret: 'csecret' };

export const ENV_TEXT = `# ---- SQL Server ----
SQL_HOST=localhost
SQL_PORT=1433
SQL_INSTANCE=
SQL_USER=backup_user
SQL_PASSWORD='p#ss w0rd'
SQL_DATABASES=Sales, HR
SQL_BACKUP_DIR=C:\\Program Files\\Microsoft SQL Server\\MSSQL16.SQLEXPRESS\\MSSQL\\Backup
SERVER_NAME=
GOOGLE_EMAIL=client@gmail.com
BACKUP_TIME=02:00
KEEP_LAST=7
KEEP_DAYS=30
HEALTHCHECK_URL=https://hc-ping.com/1234
BACKUP_ENCRYPTION_KEY=${KEY}
`;

function paths(home = '/data') {
  return appPaths({ env: { BACKUP_MANAGER_HOME: home } });
}

function cfg(over = {}, opts = {}) {
  const vars = { ...parseEnvText(ENV_TEXT), ...over };
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete vars[k];
  return envToConfig(vars, { google: GOOGLE, paths: paths(), hostname: 'SQL-BOX01', computerName: 'SQL-BOX01', ...opts });
}

test('maps the env file onto the normalized config', () => {
  const c = cfg();
  const s = c.servers[0];
  assert.equal(s.name, 'SQL-BOX01');
  assert.equal(s.host, 'localhost');
  assert.equal(s.port, 1433);
  assert.equal(s.instanceName, undefined);
  assert.equal(s.user, 'backup_user');
  assert.equal(s.password, 'p#ss w0rd');
  assert.deepEqual(s.databases, ['Sales', 'HR']);
  assert.equal(s.backupDir, 'C:\\Program Files\\Microsoft SQL Server\\MSSQL16.SQLEXPRESS\\MSSQL\\Backup');
  assert.equal(s.nativeCompression, false);
  assert.equal(s.encrypt, true);
  assert.equal(c.compression, true);
  assert.equal(c.encryption.enabled, true);
  assert.deepEqual(c.encryption.key, Buffer.alloc(32, 9));
  assert.deepEqual(c.retention, { keepLast: 7, keepDays: 30 });
  assert.equal(c.monitoring.heartbeatUrl, 'https://hc-ping.com/1234');
  assert.equal(c.google.clientId, 'cid');
  assert.equal(c.google.tokenFile, path.join(path.resolve('/data'), 'token.json'));
  assert.equal(c.workDir, path.join(path.resolve('/data'), 'work'));
  assert.equal(c.logDir, path.join(path.resolve('/data'), 'logs'));
  assert.equal(c.googleEmail, 'client@gmail.com');
  assert.equal(c.backupTime, '02:00');
  assert.equal(c.drive.rootFolder, 'MSSQL Backups');
});

test('optional values: empty retention, monitoring off, explicit server name', () => {
  const c = cfg({ KEEP_LAST: '', KEEP_DAYS: '', HEALTHCHECK_URL: '', SERVER_NAME: 'shop-1', GOOGLE_EMAIL: '' });
  assert.deepEqual(c.retention, { keepLast: undefined, keepDays: undefined });
  assert.equal(c.monitoring.heartbeatUrl, undefined);
  assert.equal(c.servers[0].name, 'shop-1');
  assert.equal(c.googleEmail, undefined);
});

test('SQL_LOCAL_BACKUP_DIR: empty = SQL_BACKUP_DIR; required for a remote SQL_HOST', () => {
  const local = cfg({}).servers[0];
  assert.equal(local.localBackupDir, path.resolve('C:\\Program Files\\Microsoft SQL Server\\MSSQL16.SQLEXPRESS\\MSSQL\\Backup'));

  assert.throws(() => cfg({ SQL_HOST: 'sqlbox' }), /SQL_LOCAL_BACKUP_DIR is empty, but SQL_HOST "sqlbox" is another machine/);
  const remote = cfg({ SQL_HOST: 'sqlbox', SQL_BACKUP_DIR: 'D:\\Backup', SQL_LOCAL_BACKUP_DIR: '/mnt/sqlbox-backup' }).servers[0];
  assert.equal(remote.backupDir, 'D:\\Backup', 'SQL Server still writes to its own path');
  assert.equal(remote.localBackupDir, path.resolve('/mnt/sqlbox-backup'));
  assert.equal(remote.trustServerCertificate, false);

  // Commands that never touch SQL Server (restore-only machine) do not need it.
  assert.doesNotThrow(() => cfg({ SQL_HOST: 'sqlbox', SQL_PASSWORD: '', SQL_DATABASES: '', SQL_BACKUP_DIR: '' }, { requireSql: false }));
});

test('named instance uses SQL Browser unless a non-default SQL_PORT is set', () => {
  assert.equal(cfg({ SQL_INSTANCE: 'SQLEXPRESS' }).servers[0].instanceName, 'SQLEXPRESS'); // template's 1433
  assert.equal(cfg({ SQL_INSTANCE: 'SQLEXPRESS', SQL_PORT: '' }).servers[0].instanceName, 'SQLEXPRESS');
  const fixed = cfg({ SQL_INSTANCE: 'SQLEXPRESS', SQL_PORT: '49172' }).servers[0];
  assert.equal(fixed.instanceName, undefined);
  assert.equal(fixed.port, 49172);
});

test('TLS options can be relaxed for a local self-signed SQL Server', () => {
  const s = cfg({ SQL_TRUST_SERVER_CERTIFICATE: 'true', SQL_ENCRYPT: 'TRUE' }).servers[0];
  assert.equal(s.trustServerCertificate, true);
  assert.equal(s.encrypt, true);
});

for (const [label, over, msg] of [
  ['empty databases', { SQL_DATABASES: ' , ' }, /^SQL_DATABASES is empty/],
  ['duplicate databases', { SQL_DATABASES: 'A,A' }, /SQL_DATABASES lists the same database twice/],
  ['bad database name', { SQL_DATABASES: 'x]y' }, /SQL_DATABASES: invalid database name "x\]y"/],
  ['empty user', { SQL_USER: '' }, /^SQL_USER is empty/],
  ['empty password', { SQL_PASSWORD: '' }, /^SQL_PASSWORD is empty \(the installer fills it in when it creates the SQL login/],
  ['missing backup dir', { SQL_BACKUP_DIR: undefined }, /^SQL_BACKUP_DIR is empty/],
  ['bad port', { SQL_PORT: '70000' }, /^SQL_PORT must be a TCP port/],
  ['non-numeric port', { SQL_PORT: 'abc' }, /^SQL_PORT must be a positive whole number/],
  ['bad keep_last', { KEEP_LAST: '0' }, /^KEEP_LAST must be a positive whole number/],
  ['bad time', { BACKUP_TIME: '2am' }, /^BACKUP_TIME must be HH:MM/],
  ['bad time 24:00', { BACKUP_TIME: '24:00' }, /^BACKUP_TIME/],
  ['http heartbeat', { HEALTHCHECK_URL: 'http://hc-ping.com/x' }, /^HEALTHCHECK_URL must be an https/],
  ['bad email', { GOOGLE_EMAIL: 'nope' }, /^GOOGLE_EMAIL is not an email/],
  ['bad server name', { SERVER_NAME: 'a b' }, /^SERVER_NAME may only contain/],
  ['empty key', { BACKUP_ENCRYPTION_KEY: '' }, /^BACKUP_ENCRYPTION_KEY is empty/],
  ['short key', { BACKUP_ENCRYPTION_KEY: 'c2hvcnQ=' }, /BACKUP_ENCRYPTION_KEY must be a 32-byte key/],
  ['bad flag', { SQL_ENCRYPT: 'yes' }, /^SQL_ENCRYPT must be true or false/],
  ['bad log level', { LOG_LEVEL: 'loud' }, /^LOG_LEVEL must be/],
]) {
  test(`rejects: ${label} (error names the key)`, () => {
    assert.throws(() => cfg(over), (e) => e instanceof ConfigError && msg.test(e.message));
  });
}

test('parseEnvText: BOM, CRLF, comments, quotes, export', () => {
  const v = parseEnvText('\uFEFFSQL_HOST=a\r\n# comment\r\nexport SQL_USER=u\r\nSQL_PASSWORD="x # y"\r\n');
  assert.deepEqual(v, { SQL_HOST: 'a', SQL_USER: 'u', SQL_PASSWORD: 'x # y' });
});

test('parseEnvText refuses unquoted "#" instead of silently truncating', () => {
  assert.throws(() => parseEnvText('SQL_HOST=a\nSQL_PASSWORD=pa#ss\n', 'f.env'),
    (e) => e instanceof ConfigError && /SQL_PASSWORD \(f\.env line 2\) contains "#"/.test(e.message));
});

test('parseEnvText reports unknown (misspelled) keys', () => {
  assert.throws(() => parseEnvText('SQL_DATABSES=a\n'), /unknown setting SQL_DATABSES/);
});

test('defaultServerName sanitizes the computer name', () => {
  assert.equal(defaultServerName('SQL-BOX01'), 'SQL-BOX01');
  assert.equal(defaultServerName('Büro PC'), 'B-ro-PC');
  assert.equal(defaultServerName('..'), 'server');
  assert.equal(defaultServerName('x'.repeat(80)).length, 64);
});

test('appHome: BACKUP_MANAGER_HOME override and Windows default', () => {
  assert.equal(appHome({ env: { BACKUP_MANAGER_HOME: '/x/y' } }), path.resolve('/x/y'));
  assert.equal(appHome({ env: { ProgramData: 'D:\\PD' }, platform: 'win32' }), 'D:\\PD\\backup-manager');
  assert.equal(appHome({ env: {}, platform: 'win32' }), 'C:\\ProgramData\\backup-manager');
  const p = appPaths({ env: { BACKUP_MANAGER_HOME: '/h', BACKUP_MANAGER_OAUTH_CLIENT: '/o.json' } });
  assert.equal(p.envFile, path.join(path.resolve('/h'), 'backup-manager.env'));
  assert.equal(p.oauthClientFile, path.resolve('/o.json'));
});

test('loadEnvConfig reads the env file and oauth-client.json', async () => {
  const home = await tmpDir();
  const oauth = path.join(home, 'oauth-client.json');
  const p = appPaths({ env: { BACKUP_MANAGER_HOME: home, BACKUP_MANAGER_OAUTH_CLIENT: oauth } });
  await assert.rejects(loadEnvConfig(p), /cannot read .*backup-manager\.env.*run the installer/);
  await fs.writeFile(p.envFile, ENV_TEXT);
  await assert.rejects(loadEnvConfig(p), /cannot read Google OAuth client file/);
  await fs.writeFile(oauth, JSON.stringify({ installed: { client_id: 'id1', client_secret: 's1' } }));
  const c = await loadEnvConfig(p, { hostname: 'h1' });
  assert.equal(c.google.clientId, 'id1');
  assert.equal(c.servers[0].name, 'h1');
  await fs.writeFile(oauth, JSON.stringify({ installed: {} }));
  await assert.rejects(loadOAuthClient(oauth), /installed\.client_id/);
});

test('isLocalSqlHost: loopback names and this computer\'s name, case-insensitive', () => {
  const me = { hostname: 'sql-box01.corp.local', computerName: 'SQL-BOX01' };
  for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '::1', '.', '(local)', '(LOCAL)', 'sql-box01', 'Sql-Box01.Corp.Local', ' localhost ']) {
    assert.equal(isLocalSqlHost(h, me), true, h);
  }
  for (const h of ['sqlbox', '10.0.0.5', 'sql-box01.other', '', undefined]) assert.equal(isLocalSqlHost(h, me), false, String(h));
});

test('SQL_TRUST_SERVER_CERTIFICATE defaults to true for a local SQL Server, false for a remote one; explicit wins', () => {
  assert.equal(cfg().servers[0].trustServerCertificate, true, 'localhost');
  assert.equal(cfg({ SQL_HOST: 'sql-box01' }).servers[0].trustServerCertificate, true, 'computer name');
  const share = { SQL_LOCAL_BACKUP_DIR: '/mnt/sqlbox-backup' };
  assert.equal(cfg({ SQL_HOST: 'sqlbox', ...share }).servers[0].trustServerCertificate, false, 'remote');
  assert.equal(cfg({ SQL_TRUST_SERVER_CERTIFICATE: 'false' }).servers[0].trustServerCertificate, false, 'explicit false on localhost');
  assert.equal(cfg({ SQL_HOST: 'sqlbox', SQL_TRUST_SERVER_CERTIFICATE: 'true', ...share }).servers[0].trustServerCertificate, true, 'explicit true on remote');
  assert.equal(cfg().servers[0].encrypt, true, 'still encrypted');
});

test('requireSql: false lets SQL_PASSWORD be empty (restore-only machine), other SQL values are still validated', () => {
  assert.equal(cfg({ SQL_PASSWORD: '' }, { requireSql: false }).servers[0].password, '');
  assert.equal(cfg({ SQL_PASSWORD: undefined }, { requireSql: false }).servers[0].password, '');
  assert.throws(() => cfg({ SQL_PORT: 'abc', SQL_PASSWORD: '' }, { requireSql: false }), /SQL_PORT/);
});

test('requireSql: false lets SQL_DATABASES and SQL_BACKUP_DIR be empty (restore-only machine)', () => {
  const s = cfg({ SQL_PASSWORD: '', SQL_DATABASES: '', SQL_BACKUP_DIR: '' }, { requireSql: false }).servers[0];
  assert.deepEqual(s.databases, []);
  assert.equal(s.backupDir, '');
  assert.throws(() => cfg({ SQL_DATABASES: '' }), /SQL_DATABASES is empty/);
  assert.throws(() => cfg({ SQL_BACKUP_DIR: '' }), /SQL_BACKUP_DIR is empty \(set it to the folder SQL Server writes backups to/);
});

test('the packaged env template has no client-specific SQL defaults', async () => {
  const text = await fs.readFile(new URL('../packaging/backup-manager.env.template', import.meta.url), 'utf8');
  const vars = parseEnvText(text);
  assert.equal(vars.SQL_DATABASES, '');
  assert.equal(vars.SQL_BACKUP_DIR, '');
  assert.equal(vars.SQL_INSTANCE, '');
  assert.equal(vars.SQL_USER, '');
  assert.equal(vars.SQL_PASSWORD, '');
});

test('requireSql: false lets SQL_USER be empty too (restore-only machine)', () => {
  assert.equal(cfg({ SQL_USER: '', SQL_PASSWORD: '' }, { requireSql: false }).servers[0].user, '');
});

test('parseEnvText reads back what install.ps1 Format-EnvValue writes (single quotes, backticks)', () => {
  const v = parseEnvText("SQL_BACKUP_DIR='D:\\SQL#Backups'\r\nSQL_HOST=`D:\\it's#x`\r\nSQL_USER=' x'\r\n");
  assert.equal(v.SQL_BACKUP_DIR, 'D:\\SQL#Backups');
  assert.equal(v.SQL_HOST, "D:\\it's#x");
  assert.equal(v.SQL_USER, ' x');
});
