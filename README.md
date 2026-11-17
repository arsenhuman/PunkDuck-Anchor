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

> **Working on the code?** See [Internals](#internals-for-developers-and-ai-agents). It covers the
> architecture, data flow, storage format, invariants and how to extend the tool.
If only the retention cleanup fails, the backup is still reported `OK` with a warning, because it is already safely on Drive.

## Requirements

- Node.js **22 LTS** (≥ 22.12). `google-auth-library@11` requires Node 22, and Node 18 and 20 are end-of-life.
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
| `monitoring.heartbeatUrl` | — (off) | Healthchecks.io ping URL (`https://` only). See *Monitoring* |

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

## Monitoring (Healthchecks.io)

The tool can send a heartbeat to [Healthchecks.io](https://healthchecks.io) (the free plan has 20 checks), so
you get an email when a client's backups **stop**. You don't have to log in to the client's server to check.

How it works:
- After each `backup` or scheduled run, the tool pings the check **only if every database succeeded**.
  The request body is a short summary, for example `3/3 OK` followed by one line per database with its file name and size.
  You can read it in the check's event log. It never contains passwords, keys or backup data.
- If any database fails, **no ping is sent**. If the server is off, the task isn't running, or backups keep
  failing, the pings stop and Healthchecks.io alerts you.
- The ping is best-effort. It times out after 10 s and is retried up to 3 times. If it still fails, a warning is logged.
  A failed ping never changes the backup result or the exit code.

Setup, once per client server:
1. On Healthchecks.io, click **Add Check** and give it the client's name.
2. Set **Period = 1 day** and **Grace Time = 4 days**. The alert then fires after **5 days** without a successful backup.
   For backups that run every day, a shorter grace time catches problems sooner.
3. Copy the check's ping URL (`https://hc-ping.com/<uuid>`) into that client's config:
   ```json
   "monitoring": { "heartbeatUrl": "env:HEALTHCHECK_URL" }
   ```
   You can also paste the URL directly. Treat it like a password, because anyone with the URL can send pings.
   If you use `env:HEALTHCHECK_URL`, that variable **must be set**: a missing variable is a config error
   for every command, so a typo can't switch monitoring off without anyone noticing. To turn monitoring off, remove the
   `monitoring` section or set `"heartbeatUrl": ""`.
   `backup-manager.example.json` contains a placeholder URL. The tool refuses to start until you replace it or remove the section.
4. Under **Integrations**, set the email address (or Telegram, Slack, …) that should get the alert.

If you leave `monitoring` out, or leave `heartbeatUrl` empty, the tool sends nothing.

Note: a manual run limited with `--server` or `--db` also pings when the databases it backed up all succeeded.
If Healthchecks.io can't be reached, a one-shot `backup` can take up to about 45 s longer to exit:
3 attempts with 10 s timeouts, plus the network library's connect timeout. The exit code is unaffected.

## Logs

Logs are JSON lines on stderr. The level is set by `LOG_LEVEL`: `debug|info|warn|error`. Passwords, tokens and keys
are redacted.

## Internals (for developers and AI agents)

This section explains how the code works, so that someone, human or AI, can change it safely without
reading every file first. Everything above it describes how to *use* the tool.

### At a glance

- **Language and runtime:** Node.js ≥ 22.12 (22 LTS), ES modules (`"type": "module"`). There is no build step and no TypeScript.
- **Entry point:** `bin/backup-manager.js` → `src/cli.js` `main(argv)`. `main` returns an exit code and does not call `process.exit`.
- **Runtime dependencies:**
  - `mssql`, the SQL Server driver (tedious).
  - `google-auth-library`, for OAuth and authorized HTTP requests.
  - `node-cron`, for scheduling.
  - The Drive API is called over **raw REST**. The project does not use `googleapis`.
- **Tests:** `npm test` runs `node --test "test/*.test.js"`. The pattern is quoted so Node expands it, which also works in Windows `cmd`. Nothing in the tests touches a real SQL Server, Google or the network,
  except a loopback HTTP server on 127.0.0.1.
- **Design rule:** I/O is **injected**. The orchestration in `src/backup.js` receives `drive`, `createSqlClient`,
  `logger` and `now` as parameters, which is what makes it unit-testable.

### File map

| File | Responsibility | Key exports |
| --- | --- | --- |
| `bin/backup-manager.js` | Shebang wrapper: runs `main`, sets `process.exitCode`, prints `Error: …` for uncaught errors | — |
| `src/cli.js` | Argument parsing (`node:util` `parseArgs`), command dispatch, human/JSON output | `main`, `USAGE` |
| `src/config.js` | Loads JSON config, resolves `env:VAR`, validates, applies defaults, parses the encryption key | `loadConfig`, `normalizeConfig`, `ConfigError`, `parseEncryptionKey` |
| `src/auth.js` | OAuth installed-app flow (loopback + PKCE + state), token file I/O, status, logout/revoke | `login`, `status`, `logout`, `getAuthorizedClient`, `startLoopbackServer` |
| `src/mssql.js` | SQL text builders + `MssqlClient` wrapper (connect, online check, BACKUP, VERIFYONLY) | `MssqlClient`, `buildBackupSql`, `buildVerifySql`, `toPoolConfig` |
| `src/drive.js` | Minimal Drive v3 client: folders, list, chunked resumable upload, download, delete, retry policy | `DriveStore`, `isRetryable`, `escapeQuery`, `APP_TAG` |
| `src/transform.js` | Streaming gzip, segmented AES-256-GCM encrypt/decrypt, hashing (SHA-256 + MD5) | `packFile`, `unpackFile`, `hashFile`, `createEncryptStream`, `createDecryptStream` |
| `src/backup.js` | Orchestration: backup → verify → pack → upload → check → retention; list; download | `runBackups`, `backupOne`, `applyRetention`, `listBackups`, `downloadBackup`, `selectTargets` |
| `src/retention.js` | Pure function that decides which backups to delete | `selectForDeletion` |
| `src/naming.js` | File names, timestamps, server-side path joining (Windows or Linux), artifact suffixes | `backupBaseName`, `joinServerPath`, `artifactName`, `parseArtifactName` |
| `src/scheduler.js` | Cron wrapper with an in-process overlap guard | `startScheduler`, `nonOverlapping` |
| `src/logger.js` | JSON-lines logger to stderr with secret redaction | `createLogger`, `redact`, `silentLogger` |
| `src/heartbeat.js` | Healthchecks.io ping after a fully successful run (best-effort, never throws) | `sendHeartbeat`, `buildSummary` |
| `src/format.js` | Shared formatting helpers | `fmtBytes` |

### Data flow of `backup` (one database)

`backupOne()` in `src/backup.js`:

```
selectTargets(config, {server, db})            # which (server, db) pairs; error if none match
  └─ per server: createSqlClient(server).connect()   # connect failure ⇒ all its DBs FAIL, others continue
       └─ per db: backupOne()
            1. sqlClient.assertDatabaseOnline(db)        SELECT state_desc FROM sys.databases WHERE name=@db
            2. sqlClient.backup(db, serverPath)          BACKUP DATABASE @db TO DISK=@path WITH CHECKSUM, COPY_ONLY, INIT, FORMAT, STATS=10 [, COMPRESSION]
            3. sqlClient.verify(serverPath)              RESTORE VERIFYONLY FROM DISK=@path WITH CHECKSUM
            4. fs.access(localBak)                       same file as seen by this process (localBackupDir)
            5. packFile(localBak → workDir/artifact)     gzip? → encrypt? → hash (sha256+md5); skipped if neither
            6. drive.ensurePath([rootFolder, server.name, db])
            7. drive.uploadResumable(...)                appProperties: bmApp, sha256, compressed, encrypted
            8. compare Drive md5Checksum/size with local ⇒ mismatch: delete upload, throw
            9. applyRetention(...)                       failure ⇒ warning + result.retentionError, still ok:true
          finally: delete packed artifact and local .bak (always, success or failure)
```

`runBackups()` returns `{ results: [{server, db, ok, fileId?, name?, bytes?, deleted?, retentionError?, error?, durationMs?}], failed }`.
The CLI exits with `1` when `failed > 0`.
After printing the results, `cli.js` calls `sendHeartbeat({ url: config.monitoring.heartbeatUrl, results, failed })`.
It pings only when `failed === 0` and at least one database ran.

### Storage layout and metadata on Google Drive

```
My Drive/
└── <drive.rootFolder>/                 default "MSSQL Backups"
    └── <server.name>/                  e.g. "prod"
        └── <database name, verbatim>/  e.g. "Sales"
            └── <sanitizedDb>_<YYYYMMDDTHHMMSSZ>.bak[.gz][.enc]
```

- **Artifact name.** Built by `naming.js`. The suffix order is fixed: `.bak`, then `.gz`, then `.enc`. `parseArtifactName` reverses it.
  The DB part is passed through `sanitizeForFile` (`[^A-Za-z0-9._-]` → `_`).
- **`appProperties` on every backup file.** These are private to the OAuth client.
  - `bmApp=backup-manager` (`APP_TAG`). **Only files carrying this tag are treated as backups**, so `list`, retention and `download` ignore everything else.
  - `sha256`: SHA-256 of the **uploaded bytes**, i.e. the artifact *after* compression and encryption.
  - `compressed` and `encrypted`: `"1"` or `"0"`. `download` reads these, not the file name, to decide how to unpack.
- **Discovery.** `listBackups()` walks the folders (root → server → db) instead of querying metadata, because
  `appProperties` values are limited to 124 bytes and DB names can be up to 128 characters.
- **Scope.** `drive.file` means the tool only sees files and folders it created. A folder created by hand in the Drive UI
  with the same name is **invisible** to it, and the tool will create its own.

### Local files

| Path | Written by | Lifetime |
| --- | --- | --- |
| `servers[].backupDir/<base>.bak` (SQL Server's view) = `localBackupDir/<base>.bak` (our view) | SQL Server | Deleted in `backupOne`'s `finally` |
| `workDir/<artifact>` | `packFile` (mode 0600) | Deleted in `backupOne`'s `finally` |
| `google.tokenFile` | `auth.writeToken` (atomic write via tmp + rename, mode 0600, dir 0700) | Until `auth logout` |
| `<outDir>/<base>.bak.download` and `.partial` | `downloadBackup` | Temporary. Renamed to `<base>.bak` on success, removed on failure |

Token file contents: `{ "refresh_token", "scope", "email", "createdAt" }`. No access token is stored.

### Encrypted file format

```
"BMENC2" (6 B) | nonce prefix (7 B) | seg_0 | seg_1 | … | seg_last
seg_i      = AES-256-GCM(plaintext_i) || tag (16 B)
plaintext_i = exactly SEGMENT_SIZE (1 MiB) bytes, except seg_last: 0..SEGMENT_SIZE bytes
IV_i       = prefix (7 B) | uint32be(i) (4 B) | lastFlag (1 B: 1 for seg_last, else 0)
AAD        = the 13-byte header
```

- **Encryptor.** Emits a segment that isn't the last only when it knows more data follows (`pending > segmentSize`).
- **Decryptor.** Opens a segment that isn't the last only when `pending > segmentSize + 16`. It always holds the last sealed segment back until `flush`, where it opens it with `lastFlag=1`.
- **Keep the two rules matched.** They are what make truncation at a segment boundary detectable. If you change one, change the other and run `test/review-fixes.test.js`.
- **Order of operations.** Compression happens **before** encryption.
- **Key.** 32 raw bytes, from the env var named by `encryption.keyEnv`, given as base64 or 64 hex characters.

### Invariants: do not break these

1. **No SQL string concatenation.** The DB name and path go in as `@db` and `@path` parameters (`NVarChar`) through
   `request().input(...).query(...)`. T-SQL accepts variables in `BACKUP DATABASE` and `TO DISK`. `test/mssql.test.js` asserts this.
2. **`COPY_ONLY` stays.** Without it, this tool would break the user's existing differential and log backup chain.
3. **One failing database must not stop the others.** Every per-DB error is caught in `runBackups`.
4. **Local cleanup always runs**, in the `finally` of `backupOne`. That way disks don't fill up after repeated failures.
5. **Never delete the newest backup.** Retention keeps a file if *any* rule keeps it (`keepLast` or `keepDays`).
6. **Never log secrets.** Use the logger. It redacts keys that match `/pass|secret|token|authorization|api.?key|encryption.?key/`
   and scrubs `Bearer …` and `refresh_token=…` from messages. Don't `console.log` config objects.
7. **Booleans in config are strict.** Only `true`, `false`, `"true"` or `"false"` are accepted, through `bool()` in `config.js`.
   This prevents `"enabled": "yes"` from silently disabling encryption.
8. **OAuth scope stays `drive.file`.** Wider scopes need Google app verification and expose the user's whole Drive.
9. **`download` refuses unsafe names and doesn't overwrite** without `force`. File names come from Drive and are untrusted.

### Retry policy (`src/drive.js`)

- **Retried, with exponential backoff and jitter, up to `maxRetries` (default 5):**
  - HTTP 429 and 5xx.
  - HTTP 403 when the reason is `rateLimitExceeded` or `userRateLimitExceeded`.
  - Network errors with codes such as `ECONNRESET`, `ETIMEDOUT` or `EAI_AGAIN`.
- **Not retried:** other 4xx responses and errors with no status or network code, such as programming bugs.
- **Resumable upload:**
  1. `POST …/upload/drive/v3/files?uploadType=resumable` returns a `Location` session URL.
  2. The file is sent with `PUT` in chunks of `chunkSize`, which must be a multiple of 256 KiB (default 8 MiB).
  3. A `308` response's `Range` header gives the next offset.
  4. After an error, the client sends `PUT` with `Content-Range: bytes */size`, reads the server's offset and resumes from there.
  5. A 404 or 410 means the session expired, which is fatal.
  6. More than `maxRetries` 308 responses that make no progress abort the upload.

### Errors and exit codes

- **Exit codes:** `0` on success. `1` on a runtime error, when any database failed, or for `auth status` when not logged in. `2` on a usage error.
- **Error types:** `ConfigError` (config problems) and `AuthError` (not logged in, OAuth failure). Other errors carry plain messages.
  Messages are written to be acted on, for example "check that servers[].localBackupDir points to the same directory as backupDir".
- **Logs:** JSON lines on **stderr**. Command output (results, lists) goes to **stdout**, so `--json` output can be piped.

### Testing approach

| Test file | Covers |
| --- | --- |
| `test/fake-drive.js` | In-memory fake of the Drive REST endpoints used by `DriveStore`. It can inject chunk failures that store half a chunk and then return 503 |
| `test/backup.test.js` | Orchestration with a fake SQL client that writes random bytes as the "`.bak`": partial failure, round trip, retention, checksum mismatch |
| `test/transform.test.js`, `test/review-fixes.test.js` | Encryption round trips at segment boundaries, plus tamper, truncation, reorder and wrong-key detection |
| `test/drive.test.js` | Folder creation and reuse, chunked upload and resume, list, download, delete, retry rules |
| `test/auth.test.js` | Token file permissions, the loopback server (good state, CSRF state, denial, timeout, multibyte state) and logout |
| `test/config.test.js`, `naming`, `retention`, `mssql`, `logger`, `scheduler`, `cli` | Unit tests for the pure parts |

Testing patterns to reuse:
- `DriveStore` takes any `request(opts) → {status, data, headers}` function. In production that is `OAuth2Client#request`. In tests, use `createFakeDriveApi().request`.
- `MssqlClient` takes `{ driver }`. Fake `ConnectionPool` and `NVarChar` the way `test/mssql.test.js` does.
- Pass `logger: silentLogger` and a deterministic `now` to orchestration functions.

### How to make common changes

- **Add a config option.** Validate it and give it a default in `normalizeConfig` (`src/config.js`); use `bool()` for booleans.
  Then document it in the README config table, add it to `backup-manager.example.json`, and add a case to `test/config.test.js`.
- **Add a CLI command.** Add a `case` in `main()` (`src/cli.js`), any new flags to `OPTIONS`, and a line in `USAGE`.
  Keep the logic in `src/backup.js`, or in a new module that takes injected dependencies, so it can be tested.
- **Add a storage backend** (S3, OneDrive, …). Implement the same surface `backup.js` uses from `DriveStore`:
  `ensurePath`, `resolvePath`, `listSubfolders`, `listBackups`, `getFile`, `uploadResumable`, `download` and `deleteFile`.
  Uploaded files must keep the `appProperties` semantics (or an equivalent metadata store).
- **Change the backup SQL.** Edit `buildBackupSql` and `buildVerifySql` in `src/mssql.js` and update `test/mssql.test.js`. Keep invariants 1 and 2.
- **Add notifications** (email, Slack). Hook into the result of `runBackups()` in `cli.js` (`backup` and `schedule` cases). Don't put them inside `backupOne`.

### Deliberately out of scope

- Web UI, Docker image, automatic `RESTORE DATABASE` into SQL Server, multi-user tenancy, notifications and service-account auth.
- Differential and transaction-log backups. Every backup is a full `COPY_ONLY` backup.
- Per-database retention overrides. Retention is global and applied separately to each database's folder.

### Known follow-ups (non-blocking review notes)

- `createEncryptStream` and `createDecryptStream` concatenate each incoming chunk onto a pending buffer of up to 1 MiB. A chunk list
  with a running byte count would reduce memory copying on very large backups.
- The rate-limit 403 check reads `err.response.data` as JSON. For streamed downloads that is a stream, so
  rate-limit 403s during `download` are not retried.
- When an upload makes no progress (repeated 308 at the same offset), it retries immediately with no backoff.

## Development

```bash
npm install
npm test                         # all unit tests (no network, no SQL Server)
node --test test/drive.test.js   # a single file
LOG_LEVEL=debug node bin/backup-manager.js backup --db Sales -c ./backup-manager.json
```

## Known issues

- None currently. `npm audit` reports 0 vulnerabilities with the dependency versions in `package-lock.json`
  (`mssql@12`, `google-auth-library@11`, `node-cron@4`).
