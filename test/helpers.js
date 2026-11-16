import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bm-test-'));
}

export function baseRawConfig(over = {}) {
  return {
    google: { clientId: 'cid', clientSecret: 'env:GSECRET' },
    servers: [
      { name: 'prod', host: 'sql1', user: 'sa', password: 'env:PW', databases: ['Sales', 'HR'], backupDir: '/var/opt/mssql/backup' },
    ],
    ...over,
  };
}

export const ENV = { GSECRET: 's3cret', PW: 'pw' };
