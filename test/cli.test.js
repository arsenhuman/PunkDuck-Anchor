import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli.js';
import { silentLogger } from '../src/logger.js';

function capture() {
  let text = '';
  return { stdout: { write: (s) => { text += s; } }, get text() { return text; } };
}

test('help and unknown command', async () => {
  let c = capture();
  assert.equal(await main(['--help'], { stdout: c.stdout, logger: silentLogger }), 0);
  assert.match(c.text, /Usage: backup-manager/);
  c = capture();
  assert.equal(await main([], { stdout: c.stdout, logger: silentLogger }), 2);
  c = capture();
  assert.equal(await main(['--bogus'], { stdout: c.stdout, logger: silentLogger }), 2);
});

test('keygen prints a 32-byte base64 key', async () => {
  const c = capture();
  assert.equal(await main(['keygen'], { stdout: c.stdout, logger: silentLogger }), 0);
  assert.equal(Buffer.from(c.text.trim(), 'base64').length, 32);
});

test('missing config file is an error', async () => {
  await assert.rejects(main(['list', '-c', '/nonexistent/x.json'], { stdout: capture().stdout, logger: silentLogger }), /cannot read config/);
});

test('schedule command is gone (Task Scheduler runs "backup")', async () => {
  const c = capture();
  assert.equal(await main(['schedule'], { stdout: c.stdout, logger: silentLogger, env: { BACKUP_MANAGER_HOME: '/nonexistent' } }), 2);
  assert.match(c.text, /Unknown command: schedule/);
  assert.doesNotMatch(c.text.split('Usage')[1], /schedule/);
});

async function home() {
  const { default: fs } = await import('node:fs/promises');
  const { default: path } = await import('node:path');
  const { tmpDir } = await import('./helpers.js');
  const dir = await tmpDir();
  const bak = path.join(dir, 'bak');
  await fs.mkdir(bak);
  await fs.writeFile(path.join(dir, 'oauth.json'), JSON.stringify({ installed: { client_id: 'i', client_secret: 's' } }));
  const env = { BACKUP_MANAGER_HOME: dir, BACKUP_MANAGER_OAUTH_CLIENT: path.join(dir, 'oauth.json') };
  const writeEnv = (extra = '') => fs.writeFile(path.join(dir, 'backup-manager.env'),
    `SQL_USER=u\r\nSQL_PASSWORD=p\r\nSQL_DATABASES=Sales\r\nSQL_BACKUP_DIR=${bak}\r\nBACKUP_ENCRYPTION_KEY=${Buffer.alloc(32, 1).toString('base64')}\r\n${extra}`);
  return { dir, env, writeEnv };
}

const okSql = () => ({
  async connect() {}, async close() {}, async serverInfo() { return { major: 15, version: '15.0', edition: 'Express Edition' }; },
  async assertDatabaseOnline() {}, async canBackup() { return true; }, async canVerify() { return true; },
});

test('check reads the env file from BACKUP_MANAGER_HOME and exits 0 only when all pass', async () => {
  const h = await home();
  let c = capture();
  assert.equal(await main(['check'], { stdout: c.stdout, env: h.env, createSqlClient: okSql }), 1);
  assert.match(c.text, /\[FAIL\] Settings: cannot read .*backup-manager\.env/);

  await h.writeEnv();
  c = capture();
  assert.equal(await main(['check', '--skip-auth'], { stdout: c.stdout, env: h.env, createSqlClient: okSql }), 0, c.text);
  assert.match(c.text, /All checks passed/);

  c = capture();
  const authStatus = async () => ({ loggedIn: false });
  assert.equal(await main(['check'], { stdout: c.stdout, env: h.env, createSqlClient: okSql, authStatus }), 1);
  assert.match(c.text, /not signed in/);

  await h.writeEnv('SQL_DATABASES2=x\r\n');
  c = capture();
  assert.equal(await main(['check'], { stdout: c.stdout, env: h.env, createSqlClient: okSql }), 1);
  assert.match(c.text, /unknown setting SQL_DATABASES2/);
});

test('commands log to the daily file in the data folder', async () => {
  const { default: fs } = await import('node:fs/promises');
  const { default: path } = await import('node:path');
  const h = await home();
  await h.writeEnv();
  await fs.mkdir(path.join(h.dir, 'logs'));
  await fs.writeFile(path.join(h.dir, 'logs', 'backup-2000-01-01.log'), '');
  // `list` fails (not signed in) after the logger is set up and old logs are cleaned.
  await assert.rejects(main(['list'], { stdout: capture().stdout, env: h.env }), /auth login/);
  const files = await fs.readdir(path.join(h.dir, 'logs'));
  assert.ok(!files.includes('backup-2000-01-01.log'), 'old log removed');
  const log = await fs.readFile(path.join(h.dir, 'logs', files[0]), 'utf8');
  assert.match(log, /old log files deleted/);
  assert.match(log, /"msg":"list failed".*auth login/);
});

test('a broken env file is recorded in the log file too', async () => {
  const { default: fs } = await import('node:fs/promises');
  const { default: path } = await import('node:path');
  const h = await home();
  await h.writeEnv('KEEP_LAST=zero\r\n');
  await assert.rejects(main(['backup'], { stdout: capture().stdout, env: h.env }), /KEEP_LAST must be a positive whole number/);
  const [file] = await fs.readdir(path.join(h.dir, 'logs'));
  assert.match(await fs.readFile(path.join(h.dir, 'logs', file), 'utf8'), /cannot load settings.*KEEP_LAST/);
});

test('auth logout works even when the env file is broken', async () => {
  const { default: fs } = await import('node:fs/promises');
  const { default: path } = await import('node:path');
  const h = await home();
  await h.writeEnv('SQL_DATABASES2=typo\r\n');
  let c = capture();
  assert.equal(await main(['auth', 'logout'], { stdout: c.stdout, env: h.env }), 0);
  assert.match(c.text, /Not logged in/);
  await fs.writeFile(path.join(h.dir, 'token.json'), JSON.stringify({ refresh_token: 'fake' }));
  c = capture();
  // revoke of a fake token fails (or there is no network): exit 1 so uninstall.ps1 can warn
  assert.equal(await main(['auth', 'logout'], { stdout: c.stdout, env: h.env }), 1);
  assert.match(c.text, /revoking it at Google failed/);
  await assert.rejects(fs.access(path.join(h.dir, 'token.json')));
});

test('check --skip-sql works without SQL_PASSWORD (restore-only machine); a normal check still needs it', async () => {
  const { default: fs } = await import('node:fs/promises');
  const { default: path } = await import('node:path');
  const h = await home();
  await fs.writeFile(path.join(h.dir, 'backup-manager.env'),
    `SQL_USER=u\r\nSQL_PASSWORD=\r\nSQL_DATABASES=Sales\r\nSQL_BACKUP_DIR=C:\\nowhere\r\nBACKUP_ENCRYPTION_KEY=${Buffer.alloc(32, 1).toString('base64')}\r\n`);
  const noSql = () => assert.fail('must not connect');
  let c = capture();
  assert.equal(await main(['check', '--skip-auth', '--skip-sql'], { stdout: c.stdout, env: h.env, createSqlClient: noSql }), 0, c.text);
  assert.match(c.text, /\[ -- \] SQL connection: skipped/);

  c = capture();
  assert.equal(await main(['check', '--skip-auth'], { stdout: c.stdout, env: h.env, createSqlClient: okSql }), 1);
  assert.match(c.text, /SQL_PASSWORD is empty \(the installer fills it in when it creates the SQL login/);
});

test('--home <dir> picks the data folder and overrides BACKUP_MANAGER_HOME (install.ps1 -Client)', async () => {
  const { default: fs } = await import('node:fs/promises');
  const { default: path } = await import('node:path');
  const h = await home();
  await h.writeEnv();
  const other = await home(); // no env file there
  const env = { BACKUP_MANAGER_HOME: other.dir, BACKUP_MANAGER_OAUTH_CLIENT: h.env.BACKUP_MANAGER_OAUTH_CLIENT };

  let c = capture();
  assert.equal(await main(['check', '--skip-auth'], { stdout: c.stdout, env, createSqlClient: okSql }), 1);
  assert.match(c.text, /cannot read .*backup-manager\.env/, 'without --home: BACKUP_MANAGER_HOME');

  for (const argv of [['--home', h.dir, 'check', '--skip-auth'], ['check', '--skip-auth', '--home', h.dir], ['check', `--home=${h.dir}`, '--skip-auth']]) {
    c = capture();
    assert.equal(await main(argv, { stdout: c.stdout, env, createSqlClient: okSql }), 0, `${argv.join(' ')}: ${c.text}`);
    assert.match(c.text, /All checks passed/);
  }

  // Logs and the token go to the --home folder too.
  await assert.rejects(main(['--home', h.dir, 'list'], { stdout: capture().stdout, env }), /auth login/);
  assert.equal((await fs.readdir(path.join(h.dir, 'logs'))).length, 1);
  await assert.rejects(fs.access(path.join(other.dir, 'logs')));
  c = capture();
  assert.equal(await main(['--home', h.dir, 'auth', 'logout'], { stdout: c.stdout, env }), 0);
  assert.match(c.text, /Not logged in/);
  assert.deepEqual(env, { BACKUP_MANAGER_HOME: other.dir, BACKUP_MANAGER_OAUTH_CLIENT: h.env.BACKUP_MANAGER_OAUTH_CLIENT }, 'the injected env is not modified');
});

test('--home needs a value', async () => {
  for (const argv of [['--home', '', 'check'], ['--home=  ', 'check']]) {
    const c = capture();
    assert.equal(await main(argv, { stdout: c.stdout, logger: silentLogger }), 2);
    assert.match(c.text, /--home needs a folder/);
  }
  const c = capture();
  assert.equal(await main(['check', '--home'], { stdout: c.stdout, logger: silentLogger }), 2);
  assert.match(c.text, /--home/);
  const u = capture();
  await main(['--help'], { stdout: u.stdout });
  assert.match(u.text, /--home <dir>/);
});
