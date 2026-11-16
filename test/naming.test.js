import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artifactName, backupBaseName, joinServerPath, parseArtifactName, timestampUtc } from '../src/naming.js';

const d = new Date('2026-11-16T02:03:04.567Z');

test('timestamp and base name', () => {
  assert.equal(timestampUtc(d), '20261116T020304Z');
  assert.equal(backupBaseName('Sales', d), 'Sales_20261116T020304Z.bak');
  assert.equal(backupBaseName('My DB/../x', d), 'My_DB_.._x_20261116T020304Z.bak');
  assert.equal(backupBaseName('.hidden', d), '_hidden_20261116T020304Z.bak');
});

test('joinServerPath handles Windows and Linux', () => {
  assert.equal(joinServerPath('/var/opt/mssql/backup', 'a.bak'), '/var/opt/mssql/backup/a.bak');
  assert.equal(joinServerPath('/backup/', 'a.bak'), '/backup/a.bak');
  assert.equal(joinServerPath('D:\\Backups', 'a.bak'), 'D:\\Backups\\a.bak');
  assert.equal(joinServerPath('D:\\Backups\\', 'a.bak'), 'D:\\Backups\\a.bak');
});

test('artifact name round-trip', () => {
  for (const compressed of [true, false]) {
    for (const encrypted of [true, false]) {
      const n = artifactName('x.bak', { compressed, encrypted });
      assert.deepEqual(parseArtifactName(n), { baseName: 'x.bak', compressed, encrypted });
    }
  }
  assert.equal(artifactName('x.bak', { compressed: true, encrypted: true }), 'x.bak.gz.enc');
});
