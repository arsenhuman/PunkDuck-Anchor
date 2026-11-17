// Where the program and its data live.
//
// Program files (read-only):  the folder that contains bin/ and src/ (C:\Program Files\backup-manager).
// Data (env file, token, logs, scratch): BACKUP_MANAGER_HOME, default C:\ProgramData\backup-manager.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_NAME = 'backup-manager';

/** Folder containing bin/, src/, package.json and (in a release) node.exe and oauth-client.json. */
export const APP_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Data folder. BACKUP_MANAGER_HOME overrides it (tests, development). */
export function appHome({ env = process.env, platform = process.platform } = {}) {
  if (env.BACKUP_MANAGER_HOME) return path.resolve(env.BACKUP_MANAGER_HOME);
  if (platform === 'win32') return path.win32.join(env.ProgramData || 'C:\\ProgramData', APP_NAME);
  return path.join(os.homedir(), '.config', APP_NAME); // development on Linux/macOS
}

export function appPaths(opts = {}) {
  const home = appHome(opts);
  const env = opts.env ?? process.env;
  return {
    home,
    envFile: path.join(home, `${APP_NAME}.env`),
    tokenFile: path.join(home, 'token.json'),
    logDir: path.join(home, 'logs'),
    workDir: path.join(home, 'work'),
    oauthClientFile: env.BACKUP_MANAGER_OAUTH_CLIENT
      ? path.resolve(env.BACKUP_MANAGER_OAUTH_CLIENT)
      : path.join(APP_ROOT, 'oauth-client.json'),
  };
}
