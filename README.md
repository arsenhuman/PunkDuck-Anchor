# PunkDuck-Anchor — backup-manager

A Node.js CLI that takes **native SQL Server backups** (`BACKUP DATABASE … TO DISK`) and uploads
them to the **Google Drive** of a Gmail / Google account you connect with OAuth.

What one backup run does for each database:

1. Checks that the database exists and is `ONLINE`.
2. Runs `BACKUP DATABASE @db TO DISK = @path WITH CHECKSUM, COPY_ONLY, INIT, FORMAT`. The database name and path are passed as parameters and are never concatenated into the SQL.
   `COPY_ONLY` means the tool doesn't break your existing differential or log backup chain.
3. Runs `RESTORE VERIFYONLY … WITH CHECKSUM`.
4. Streams the `.bak` through gzip and, if enabled, AES-256-GCM encryption.
5. Uploads the result with a chunked, **resumable** Drive upload. Failed chunks are retried with backoff and the upload resumes from the server's offset.
   The upload goes to `<rootFolder>/<server>/<database>/`. The tool compares Drive's MD5 and size with the local file and deletes the upload if they don't match.
6. Applies the retention policy and removes all local temporary files.

If one database fails, the others still run. The exit code is `1` if any database failed.
If only the retention cleanup fails, the backup is still reported `OK` with a warning, because it is already safely on Drive.

## Requirements

- Node.js ≥ 18.17. Node 20+ is recommended (see *Known issues*).
- The tool must be able to **read the directory SQL Server writes backups to**. Either run it on the
  SQL Server host, or mount that directory (NFS/SMB/Docker volume). `backupDir` is the path as
  **SQL Server** sees it. `localBackupDir` is the same directory as **this tool** sees it.
  It defaults to `backupDir`.
- The SQL login needs `BACKUP DATABASE` permission on each database. Grant it with the `db_backupoperator` role,
  plus `VIEW ANY DATABASE` (the default) so the tool can read `sys.databases`.
- The **SQL Server service account** must be able to write to `backupDir`. The OS user running
  this tool must be able to read **and delete** files there.

```sql
USE Sales;
CREATE USER backup_user FOR LOGIN backup_user;
ALTER ROLE db_backupoperator ADD MEMBER backup_user;
```

## Install

```bash
npm install
npm link        # optional: puts `backup-manager` on your PATH
```

## 1. Create a Google OAuth client (one time)

1. Open <https://console.cloud.google.com/> and create (or pick) a project.
2. Go to **APIs & Services → Library** and enable the **Google Drive API**.
3. Go to **APIs & Services → OAuth consent screen**, choose *External*, and fill in the app name and
   your email. Add your Gmail address under **Test users**. While the app is in *Testing* mode,
   Google expires refresh tokens after 7 days. **Publish** the app to avoid that. It only
   requests the non-sensitive `drive.file` scope, so verification is not required.
4. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**, with application type
   **Desktop app**. Copy the client ID and secret.

The tool only asks for `https://www.googleapis.com/auth/drive.file`. It can see and change **only
the files it created**, never the rest of your Drive.

## 2. Configure

```bash
cp backup-manager.example.json backup-manager.json
export GOOGLE_CLIENT_SECRET='...'
export MSSQL_PASSWORD='...'
export BACKUP_ENCRYPTION_KEY="$(backup-manager keygen)"   # if encryption.enabled — STORE THIS KEY SAFELY
```

Any string value can be written as `"env:VAR_NAME"` to read it from the environment.

| Key | Default | Meaning |
| --- | --- | --- |
| `google.clientId` / `clientSecret` | — (required) | The OAuth client from step 1 |
| `google.tokenFile` | `~/.config/backup-manager/token.json` | Where the refresh token is stored (mode 0600) |
| `drive.rootFolder` | `MSSQL Backups` | Top-level Drive folder |
| `servers[].name` | — | Short label `[A-Za-z0-9._-]`, used as the Drive sub-folder |
| `servers[].host`, `port`, `instanceName` | port `1433` | Connection settings |
| `servers[].user`, `password` | — | SQL login |
| `servers[].encrypt`, `trustServerCertificate` | `true`, `false` | TLS to SQL Server |
| `servers[].databases` | — | Databases to back up |
| `servers[].backupDir` | — | Backup directory as SQL Server sees it (Linux or Windows path) |
| `servers[].localBackupDir` | `backupDir` | The same directory as this tool sees it |
| `servers[].nativeCompression` | `false` | Adds `WITH COMPRESSION` (not available on Express edition) |
| `servers[].requestTimeoutMs` | 6 h | Max time for a single BACKUP statement (`0` = no limit) |
| `retention.keepLast` | — | Keep the newest N backups per database |
| `retention.keepDays` | — | Keep backups younger than N days |
| `compression` | `true` | gzip before upload |
| `encryption.enabled` / `keyEnv` | `false` / `BACKUP_ENCRYPTION_KEY` | AES-256-GCM. The key is 32 bytes, base64 or hex |
| `workDir` | OS temp dir + `/backup-manager` | Scratch space for compressed or encrypted files |
| `schedule.cron` / `timezone` | — | Used by `backup-manager schedule` |

**Retention:** a backup is kept if **any** configured rule keeps it. That means it is either one of the newest
`keepLast`, or younger than `keepDays`. The newest backup is never deleted. With no rules set,
nothing is deleted. Deleted backups are removed permanently and do not go to the Drive trash.

**Encryption:** if you lose the key, you cannot restore the backups. Keep it somewhere other than
the Google account, for example in a password manager.

## 3. Connect your Google account

```bash
backup-manager auth login --email you@gmail.com
```

This prints a Google consent URL. Open it, sign in with your Gmail account and approve.
Google redirects to a temporary `http://127.0.0.1:<random port>` listener started by the tool.
The login uses PKCE and a `state` check. Only the refresh token is saved.

On a headless server, run `auth login` on a machine with a browser, then copy the token file
to the server with mode 0600.

```bash
backup-manager auth status    # shows the connected Gmail address
backup-manager auth logout    # revokes the token at Google and deletes it locally
```

## 4. Use it

```bash
backup-manager backup                       # all configured databases
backup-manager backup --server prod --db Sales
backup-manager list [--db Sales] [--json]
backup-manager download latest --db Sales --out ./restore
backup-manager download <fileId> --out ./restore
backup-manager schedule                     # long-running, uses schedule.cron
```

`download` checks the SHA-256, then decrypts and decompresses, and writes a plain `.bak` file. It won't overwrite an
existing file unless you pass `--force`. Restoring that
file into SQL Server is a manual step on purpose, for example:

```sql
RESTORE DATABASE Sales_restored FROM DISK = N'/var/opt/mssql/backup/Sales_20261116T020000Z.bak'
WITH MOVE 'Sales' TO '/var/opt/mssql/data/Sales_restored.mdf',
     MOVE 'Sales_log' TO '/var/opt/mssql/data/Sales_restored_log.ldf';
```

### Running on a schedule

There are two ways. You can run `backup-manager schedule` under systemd or pm2, which will skip a tick if the previous run is still going
and waits for a running backup to finish on SIGTERM. Or you can call `backup-manager backup` from
system cron, for example:

```cron
0 2 * * * cd /opt/backup-manager && ./bin/backup-manager.js backup >> /var/log/backup-manager.log 2>&1
```

Logs are JSON lines on stderr. The level is set by `LOG_LEVEL`: `debug|info|warn|error`. Passwords, tokens and keys
are redacted.

## Encrypted file format

`BMENC2` (6 bytes) | nonce prefix (7 bytes) | segments… The data is compressed first, then encrypted.
Each segment holds 1 MiB of plaintext, AES-256-GCM encrypted, followed by a 16-byte auth tag. The last segment can be shorter.
Segment *i* uses the IV `prefix | uint32be(i) | lastFlag`, and the header is authenticated as AAD.
Changing, reordering, dropping or cutting off any segment makes decryption fail. Because the file is
split into segments, it avoids the single-message GCM limit of about 64 GiB.

## Development

```bash
npm test     # node:test unit tests; SQL Server and Google Drive are faked
```

## Known issues

- On Node 18 the project pins `mssql@10`, plus an npm `overrides` entry for a transitive `https-proxy-agent`.
  This is needed because newer Azure SDK releases pulled in by `tedious` no longer load on Node 18.
  `npm audit` reports moderate advisories in those transitive Azure and uuid packages. They are in
  code paths this tool does not use (Azure AD auth, uuid buffer writes). On Node 20+ you can upgrade to
  `mssql@11` and remove the override.
- `node-cron@4` declares `engines.node >=20`, so `npm install` on Node 18 prints an `EBADENGINE`
  warning. It runs correctly on 18.19, and the test suite covers it. `node-cron@3` would avoid the warning,
  but it depends on a uuid version with a security advisory.
