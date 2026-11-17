# PunkDuck-Anchor: backup-manager

A Windows program that takes **native SQL Server backups** (`BACKUP DATABASE ... TO DISK`) every night and uploads
them, compressed and encrypted, to the **client's own Google Drive**.

- **Target:** Windows 10/11 x64, SQL Server 2016 or newer (Express included). One SQL Server per machine.
- **Delivery:** a self-contained release zip (bundled `node.exe`, nothing to install beforehand), installed by
  **our team over RDP** with `install.ps1`.
- **Scheduling:** Windows Task Scheduler, task **"PunkDuck Backup Manager"**, daily, as SYSTEM.
- **Monitoring:** Healthchecks.io, one check per client.
- **Restores:** always done by our team. See [RESTORE.md](RESTORE.md).

What one backup run does for each database:

1. Checks that the database exists and is `ONLINE`.
2. Runs `BACKUP DATABASE @db TO DISK = @path WITH CHECKSUM, COPY_ONLY, INIT, FORMAT`. The database name and path are
   passed as parameters and are never concatenated into the SQL. `COPY_ONLY` means the tool doesn't break the
   client's existing differential or log backup chain.
3. Runs `RESTORE VERIFYONLY ... WITH CHECKSUM`.
4. Streams the `.bak` through gzip and AES-256-GCM encryption.
5. Uploads the result with a chunked, **resumable** Drive upload to `MSSQL Backups/<SERVER_NAME>/<database>/`, and
   compares Drive's MD5 and size with the local file.
6. Applies the retention policy and removes all local temporary files.

If one database fails, the others still run. The exit code is `1` if any database failed.

> **Working on the code?** See [Internals](#internals-for-developers-and-ai-agents).

## Paths on the client machine

| What | Path |
| --- | --- |
| Program | `C:\Program Files\backup-manager\` |
| Settings (env file) | `C:\ProgramData\backup-manager\backup-manager.env` |
| Google sign-in | `C:\ProgramData\backup-manager\token.json` |
| Logs | `C:\ProgramData\backup-manager\logs\backup-YYYY-MM-DD.log` (kept 30 days) |
| Scratch | `C:\ProgramData\backup-manager\work\` |

Both folders are restricted to **SYSTEM and Administrators** by the installer (`icacls`). The data folder can be
moved with the `BACKUP_MANAGER_HOME` environment variable (used by the tests).

## One-time setup (our company)

### Google OAuth client

All clients use **one company-owned OAuth client** of type *Desktop app*. Each client signs in with **their own**
Google account, and backups go to **their own** Drive. We have no access to any client's Drive.
The only scope is `drive.file`: the program sees only the files and folders it created.

1. In <https://console.cloud.google.com/>, create a project and enable the **Google Drive API**.
2. **Google Auth Platform > Branding** (older menus: *OAuth consent screen*): audience *External*, app name
   "PunkDuck Backup Manager", support and developer contact email. **Don't upload a logo**: that triggers brand
   verification. Optionally declare the scope `.../auth/drive.file` under **Data access**.
3. **Clients > Create client**, application type **Desktop app**. Keep the client ID and secret in the company
   password manager.
4. **Audience:** a new app is in *Testing* mode. Only users listed under **Test users** can sign in, and their
   sign-ins expire after 7 days. That is fine for trying things out; add your test Gmail there.
   **Before the first real client, click Publish app.** `drive.file` is a non-sensitive scope, so publishing needs no
   Google review.
5. Store the client ID and secret as GitHub repository secrets `GOOGLE_OAUTH_CLIENT_ID` and
   `GOOGLE_OAUTH_CLIENT_SECRET` (`gh secret set GOOGLE_OAUTH_CLIENT_ID -R arsenhuman/PunkDuck-Anchor`, same for the
   secret). The release build writes them into `oauth-client.json` inside the zip. The file is never committed.

**Why the "secret" can ship in a public zip:** the client ID and secret only identify our *program* to Google. For a
Desktop app, Google does not treat the secret as confidential, because any installed program can be taken apart.
Access is protected by the client's own sign-in and approval, PKCE, and the per-machine refresh token in
`token.json`, which is the real secret and never leaves the machine. Technicians and clients never handle the client
ID or secret: they are inside the release.

### Releases

Prerequisite: the two repository secrets above. Without them the build step fails and nothing is published.

1. Bump `version` in `package.json`, commit, then tag and push: `git tag -a v1.2.0 -m v1.2.0 && git push origin v1.2.0`.
   The tag must match `package.json` (`v` + version), or the workflow stops.
2. `.github/workflows/release.yml` (Windows runner) runs the tests, checks that the tag matches `package.json`, runs
   `scripts/build-package.js` and creates a GitHub Release with:
   - `backup-manager-<version>-win-x64.zip`: `node.exe` (official Node 22 build, checked against `SHASUMS256.txt`),
     the app, production `node_modules`, `oauth-client.json`, the env template, the install/uninstall scripts and
     `backup-manager.cmd`;
   - `backup-manager-<version>-win-x64.zip.sha256`;
   - `install.ps1`.

A release is public and immediately becomes "latest", which is what `irm ... | iex` installs. Test a new version on
a Windows VM first; to fix a bad release, publish the next patch version.

`.github/workflows/ci.yml` runs `npm ci` + `npm test` on `windows-latest` and `ubuntu-latest` for every push and
pull request, and makes Windows PowerShell 5.1 parse the `.ps1` scripts.

### Healthchecks.io (per client)

1. On Healthchecks.io, **Add Check** with the client's name.
2. Set **Period = 1 day** and **Grace Time = 4 days**. The alert fires after **5 days** without a successful backup.
3. Under **Integrations**, set who gets the alert.
4. Put the check's ping URL (`https://hc-ping.com/<uuid>`) in the client's `HEALTHCHECK_URL`. Treat it like a
   password: anyone with the URL can send pings.

After each run, the program pings the check **only if every database succeeded**. The body is a short summary
(`3/3 OK` plus one line per database); it never contains passwords, keys or backup data. If a backup fails, the
machine is off, or the client revoked Google access, the pings stop and Healthchecks alerts us.
The ping is best-effort (10 s timeout, 3 attempts) and never changes the backup result.

## Installing on a client machine (over RDP)

Before you start, have ready: the SQL login (see *SQL Server preparation*), the client's Gmail address and password
(or the client at hand to sign in), the Healthchecks ping URL, and access to the company password manager.

Open **Windows PowerShell as Administrator** and run:

```powershell
# latest release
irm https://github.com/arsenhuman/PunkDuck-Anchor/releases/latest/download/install.ps1 | iex

# a pinned version
irm https://github.com/arsenhuman/PunkDuck-Anchor/releases/download/v1.2.0/install.ps1 -OutFile install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Version 1.2.0
```

Installer options (they need the `-File` form, not `irm | iex`):

| Option | Use |
| --- | --- |
| `-Version 1.2.0` | Install that release instead of the latest |
| `-ZipPath .\backup-manager-1.2.0-win-x64.zip` | Offline install when GitHub is blocked: copy the zip **and** its `.sha256` into the same folder first |
| `-RestoreOnly` | Restore machine for another client's backups: no scheduled task, no backup. See [RESTORE.md](RESTORE.md) |

The installer:

1. Checks for Administrator rights and Windows 10/11 x64.
2. Downloads the zip and its `.sha256` (or takes them from `-ZipPath`) and verifies the hash.
3. Extracts to `C:\Program Files\backup-manager\` (only the program files are replaced).
4. If `backup-manager.env` doesn't exist, creates it from the template and opens it in **Notepad**. Fill it in,
   save, close Notepad and press Enter.
5. If `BACKUP_ENCRYPTION_KEY` is empty, generates a key, writes it into the env file and **shows it once**.
   **Store it in the company password manager** under the client, then type `SAVED`.
6. Locks both folders down to SYSTEM and Administrators.
7. Runs `backup-manager check` (without the Google part). On failure it stops with a plain-language explanation.
   Fix the env file and run the installer again; re-running is safe.
8. Runs `backup-manager auth login` if there is no working Google sign-in (see *Google sign-in*), then the full
   `check` again. It stops if the signed-in account is not `GOOGLE_EMAIL`.
9. Registers or updates the scheduled task "PunkDuck Backup Manager": daily at `BACKUP_TIME`, as SYSTEM with highest
   privileges, run as soon as possible after a missed start, 12-hour limit, no overlapping runs.
10. Runs the first backup and prints the result.

**On a stock SQL Server Express, the first `check` usually fails** on one of the traps in *SQL Server
preparation*, most often the self-signed TLS certificate: add `SQL_TRUST_SERVER_CERTIFICATE=true` to the env file
(`notepad C:\ProgramData\backup-manager\backup-manager.env` in the Administrator PowerShell) and run the
installer again. It keeps what you already entered.

**Update:** run the installer again. It keeps the env file, the key and the Google sign-in. It refuses to update
while a backup is running.

**Uninstall:**

```powershell
# removes the scheduled task and the program folder; keeps C:\ProgramData\backup-manager
powershell -ExecutionPolicy Bypass -File "C:\Program Files\backup-manager\uninstall.ps1"
# also revokes the Google sign-in and deletes C:\ProgramData\backup-manager
powershell -ExecutionPolicy Bypass -File "C:\Program Files\backup-manager\uninstall.ps1" -Purge
```

**Backups on Google Drive are never touched** by the uninstaller.

### SQL Server preparation

Do this in SSMS, connected as an administrator, before running the installer:

1. **Enable mixed-mode authentication** (Express often allows Windows logins only): server Properties > Security >
   "SQL Server and Windows Authentication mode", then restart the SQL Server service. Without it the SQL login
   below can't sign in.
2. **Enable TCP/IP** in SQL Server Configuration Manager (see the table below) and restart the service.
3. **Create a SQL login** for the program and give it backup rights on **each** database in `SQL_DATABASES`:

```sql
CREATE LOGIN backup_user WITH PASSWORD = '<strong password>';
USE Sales;
CREATE USER backup_user FOR LOGIN backup_user;
ALTER ROLE db_backupoperator ADD MEMBER backup_user;
-- repeat USE / CREATE USER / ALTER ROLE for every other database
```

4. **Find the backup folder** for `SQL_BACKUP_DIR`: SSMS > server Properties > Database Settings > *Backup*. Default:
   `C:\Program Files\Microsoft SQL Server\MSSQL<nn>.<INSTANCE>\MSSQL\Backup`, where `<nn>` is 13 for SQL Server
   2016, 14 for 2017, 15 for 2019 and 16 for 2022, and `<INSTANCE>` is e.g. `SQLEXPRESS` (or `MSSQLSERVER` for a
   default instance).

Common SQL Server Express traps, all detected by `backup-manager check`:

| Problem | Fix |
| --- | --- |
| **TCP/IP is disabled** (Express default) | SQL Server Configuration Manager > SQL Server Network Configuration > Protocols > enable TCP/IP, restart the SQL Server service |
| **SQL Browser stopped** with a named instance (`SQL_INSTANCE=SQLEXPRESS`) | Start the "SQL Server Browser" service (Automatic), or set `SQL_PORT` to the instance's fixed port |
| **Mixed-mode authentication disabled** (Windows logins only) | SSMS > server Properties > Security > "SQL Server and Windows Authentication mode", restart |
| **Login failed** | Wrong `SQL_USER`/`SQL_PASSWORD`, or the login is disabled |
| **Self-signed TLS certificate** | Add `SQL_TRUST_SERVER_CERTIFICATE=true` (fine for a SQL Server on the same machine) |
| **No backup compression on Express** | Nothing to do: native compression stays off and the program compresses with gzip |

## Settings: `backup-manager.env`

The env file is the **only** supported configuration. Format: `KEY=VALUE`, `#` starts a comment line.

```ini
# ---- SQL Server ----
SQL_HOST=localhost
SQL_PORT=1433
# For a named instance such as SQLEXPRESS (needs the SQL Browser service, or set SQL_PORT instead):
SQL_INSTANCE=
SQL_USER=backup_user
SQL_PASSWORD=
# Comma-separated
SQL_DATABASES=Sales,HR
# Folder SQL Server writes backups to (must be readable by this program)
SQL_BACKUP_DIR=C:\Program Files\Microsoft SQL Server\MSSQL16.SQLEXPRESS\MSSQL\Backup

# ---- Naming on Google Drive (default: computer name) ----
SERVER_NAME=

# ---- Google account (the client's own Gmail; backups go to THEIR Drive) ----
GOOGLE_EMAIL=client@gmail.com

# ---- Schedule & retention ----
BACKUP_TIME=02:00
KEEP_LAST=7
KEEP_DAYS=30

# ---- Monitoring (Healthchecks.io ping URL for this client) ----
HEALTHCHECK_URL=

# ---- Encryption (ON by default; leave empty and the installer generates a key and shows it ONCE) ----
BACKUP_ENCRYPTION_KEY=
```

| Key | Default | Meaning |
| --- | --- | --- |
| `SQL_HOST` | `localhost` | SQL Server host. It must run on this machine (the program reads the `.bak` from `SQL_BACKUP_DIR`) |
| `SQL_PORT` | `1433` | TCP port. With `SQL_INSTANCE` set, a value other than 1433 means "connect to this port directly, skip SQL Browser" |
| `SQL_INSTANCE` | (none) | Named instance, e.g. `SQLEXPRESS`. Found through the SQL Browser service |
| `SQL_USER`, `SQL_PASSWORD` | required | SQL login |
| `SQL_DATABASES` | required | Comma-separated database names |
| `SQL_BACKUP_DIR` | required | Folder SQL Server writes backups to |
| `SERVER_NAME` | computer name | Drive sub-folder name (`A-Z a-z 0-9 . _ -`) |
| `GOOGLE_EMAIL` | (none) | Expected Google account; used as the sign-in hint, and `check` fails if a different account is signed in |
| `BACKUP_TIME` | `02:00` | Daily start time (24-hour `HH:MM`), used by the installer for the scheduled task. Re-run the installer after changing it |
| `KEEP_LAST` / `KEEP_DAYS` | (none) | Retention: a backup is kept if it is one of the newest `KEEP_LAST` **or** younger than `KEEP_DAYS`. The newest backup is never deleted. With neither set, nothing is deleted |
| `HEALTHCHECK_URL` | (none: monitoring off) | Healthchecks.io ping URL, `https://` only |
| `BACKUP_ENCRYPTION_KEY` | required | 32-byte key, base64 or hex. **Never change it** after the first backup; old backups need the old key |
| `SQL_ENCRYPT` / `SQL_TRUST_SERVER_CERTIFICATE` | `true` / `false` | TLS to SQL Server (optional, not in the template) |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` (optional) |

Rules:
- **Values containing `#` must be quoted with single quotes**, e.g. `SQL_PASSWORD='ab#12'`. An unquoted `#` is
  rejected rather than silently cutting the value. Don't use double quotes around Windows paths (`\n` would be
  turned into a line break).
- Unknown keys are reported as errors, so typos don't go unnoticed.
- Every error names the key to fix, e.g. `SQL_DATABASES is empty`.

## Google sign-in

`backup-manager auth login` (run by the installer) prints a Google sign-in URL.

- **With a browser on the machine:** open the URL, sign in with the client's account and approve. Google redirects to a
  temporary `http://127.0.0.1:<port>` listener and the program finishes by itself.
- **Without a usable browser** (the usual case over RDP): open the URL on **your own laptop**, sign in with the
  client's account and approve. The browser then tries to open `http://127.0.0.1:...` and **fails to load; that is
  expected**. Copy that full address from the address bar and paste it into the RDP console, then press Enter.
  Pasting only the `code` value also works.

The `state` value in a pasted address is checked, and the code is always redeemed with this login's PKCE verifier,
so a code from any other sign-in is useless. Only the refresh token is stored (`token.json`).

```powershell
& "C:\Program Files\backup-manager\backup-manager.cmd" auth status   # which account is connected
& "C:\Program Files\backup-manager\backup-manager.cmd" auth logout   # revoke and delete the sign-in
```

**If a client revokes access** (or changes their Google password in some cases), uploads stop and Healthchecks
alerts us. Fix: run `auth login` again.

## Encryption key

- Encryption is **always on** (AES-256-GCM, `BMENC2` format).
- The installer generates the key and shows it **once**. We store it in the **company password manager**. It also
  stays in the ACL-protected env file, because the nightly backups need it.
- **If the key is lost, that client's backups cannot be restored.**

## Everyday commands

Run in an Administrator PowerShell, after `$bm = "C:\Program Files\backup-manager\backup-manager.cmd"`.
`--server` picks the Drive folder of another machine (`SERVER_NAME`); it is only needed on a restore machine.

```powershell
& $bm check                                # verify settings, SQL Server, folder, Google; exit 0 only if all pass
& $bm backup                               # back up now (what the scheduled task runs)
& $bm list [--db Sales] [--server NAME] [--json]   # backups on Google Drive
& $bm download latest --db Sales [--server NAME] --out D:\restore   # see RESTORE.md
& $bm auth status                          # which Google account is connected
& $bm --help                               # all commands and options
```

## Logs

Each run appends JSON lines to `C:\ProgramData\backup-manager\logs\backup-YYYY-MM-DD.log` (local date) and also
writes them to stderr. Passwords, tokens and keys are redacted. Log files older than 30 days are deleted at the start
of each run.

To see why a scheduled run failed: Task Scheduler > "PunkDuck Backup Manager" > Last Run Result, then the log file
of that day.

## Internals (for developers and AI agents)

This section explains how the code works, so that someone, human or AI, can change it safely without
reading every file first. Everything above it describes how to *use* the tool.

### At a glance

- **Language and runtime:** Node.js ≥ 22.12 (22 LTS), ES modules (`"type": "module"`). No TypeScript. The only build step
  is packaging the Windows release (`npm run build:package`).
- **Product shape:** Windows-only. Settings come from the env file (`src/envconfig.js`), paths from `src/paths.js`,
  scheduling from Windows Task Scheduler (`packaging/install.ps1`). There is no in-process scheduler.
- **Entry point:** `bin/backup-manager.js` → `src/cli.js` `main(argv)`. `main` returns an exit code and does not call `process.exit`.
- **Runtime dependencies:**
  - `mssql`, the SQL Server driver (tedious).
  - `google-auth-library`, for OAuth and authorized HTTP requests.
  - The Drive API is called over **raw REST**. The project does not use `googleapis`.
- **Tests:** `npm test` runs `node --test "test/*.test.js"`. The pattern is quoted so Node expands it, which also works in Windows `cmd`. Nothing in the tests touches a real SQL Server or Google data,
  and the only network use is a loopback HTTP server on 127.0.0.1, with one exception: the logout tests
  (`test/auth.test.js`, `test/cli.test.js`) call Google's token-revoke endpoint with a fake token. They pass whether
  Google rejects the token or the network is unreachable.
- **Design rule:** I/O is **injected**. The orchestration in `src/backup.js` receives `drive`, `createSqlClient`,
  `logger` and `now` as parameters, which is what makes it unit-testable.

### File map

| File | Responsibility | Key exports |
| --- | --- | --- |
| `packaging/install.ps1`, `uninstall.ps1` | Windows install/update/uninstall (PowerShell 5.1, pure ASCII) | — |
| `packaging/backup-manager.cmd` | Launcher: runs `bin/backup-manager.js` with the bundled `node.exe` | — |
| `packaging/backup-manager.env.template` | Commented env file template copied by the installer | — |
| `scripts/build-package.js` | Builds the release zip (downloads + verifies Node, `npm ci --omit=dev`, writes `oauth-client.json`) | `build`, `verifyShasum`, `oauthClientJson` |
| `bin/backup-manager.js` | Shebang wrapper: runs `main`, sets `process.exitCode`, prints `Error: …` for uncaught errors | — |
| `src/cli.js` | Argument parsing (`node:util` `parseArgs`), command dispatch, human/JSON output | `main`, `USAGE` |
| `src/envconfig.js` | Parses `backup-manager.env` (`util.parseEnv`), validates with env-key error messages, maps onto `normalizeConfig`; reads `oauth-client.json` | `loadEnvConfig`, `envToConfig`, `parseEnvText`, `ENV_KEYS` |
| `src/paths.js` | Program folder (`APP_ROOT`) and data folder (`BACKUP_MANAGER_HOME`, default `C:\ProgramData\backup-manager`) | `appHome`, `appPaths`, `APP_ROOT` |
| `src/check.js` | The `check` command: all checks with injected I/O, SQL error explanations | `runChecks`, `explainSqlError`, `formatChecks` |
| `src/config.js` | Validates and applies defaults (`normalizeConfig`); internal JSON loader (`-c`, development only) | `loadConfig`, `normalizeConfig`, `ConfigError`, `parseEncryptionKey` |
| `src/auth.js` | OAuth installed-app flow (loopback + PKCE + state, plus paste fallback), token file I/O, status, logout/revoke | `login`, `status`, `logout`, `getAuthorizedClient`, `startLoopbackServer`, `parsePastedRedirect` |
| `src/mssql.js` | SQL text builders + `MssqlClient` wrapper (connect, online check, BACKUP permission, version, BACKUP, VERIFYONLY) | `MssqlClient`, `buildBackupSql`, `buildVerifySql`, `toPoolConfig` |
| `src/drive.js` | Minimal Drive v3 client: folders, list, chunked resumable upload, download, delete, retry policy | `DriveStore`, `isRetryable`, `escapeQuery`, `APP_TAG` |
| `src/transform.js` | Streaming gzip, segmented AES-256-GCM encrypt/decrypt, hashing (SHA-256 + MD5) | `packFile`, `unpackFile`, `hashFile`, `createEncryptStream`, `createDecryptStream` |
| `src/backup.js` | Orchestration: backup → verify → pack → upload → check → retention; list; download | `runBackups`, `backupOne`, `applyRetention`, `listBackups`, `downloadBackup`, `selectTargets` |
| `src/retention.js` | Pure function that decides which backups to delete | `selectForDeletion` |
| `src/naming.js` | File names, timestamps, server-side path joining (Windows or Linux), artifact suffixes | `backupBaseName`, `joinServerPath`, `artifactName`, `parseArtifactName` |
| `src/logger.js` | JSON-lines logger to stderr and the daily log file, secret redaction, 30-day cleanup | `createLogger`, `cleanupLogs`, `redact`, `silentLogger` |
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
| `SQL_BACKUP_DIR/<base>.bak` | SQL Server | Deleted in `backupOne`'s `finally` |
| `workDir/<artifact>` | `packFile` (mode 0600) | Deleted in `backupOne`'s `finally` |
| `<data>/token.json` | `auth.writeToken` (atomic write via tmp + rename; mode 0600 on Linux, folder ACL on Windows) | Until `auth logout` |
| `<data>/logs/backup-YYYY-MM-DD.log` | `createLogger` | 30 days (`cleanupLogs` at the start of each run) |
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
- **Key.** 32 raw bytes, from `BACKUP_ENCRYPTION_KEY` in the env file, given as base64 or 64 hex characters.

### Invariants: do not break these

1. **No SQL string concatenation.** The DB name and path go in as `@db` and `@path` parameters (`NVarChar`) through
   `request().input(...).query(...)`. T-SQL accepts variables in `BACKUP DATABASE` and `TO DISK`. `test/mssql.test.js` asserts this.
2. **`COPY_ONLY` stays.** Without it, this tool would break the user's existing differential and log backup chain.
3. **One failing database must not stop the others.** Every per-DB error is caught in `runBackups`.
4. **Local cleanup always runs**, in the `finally` of `backupOne`. That way disks don't fill up after repeated failures.
5. **Never delete the newest backup.** Retention keeps a file if *any* rule keeps it (`keepLast` or `keepDays`).
6. **Never log secrets.** Use the logger. It redacts keys that match `/pass|secret|token|authorization|api.?key|encryption.?key/`
   and scrubs `Bearer …` and `refresh_token=…` from messages. Don't `console.log` config objects.
7. **Settings are strict.** Booleans accept only `true`/`false`; unknown env keys and unquoted `#` are errors; every
   error names the env key. This prevents typos from silently changing behaviour.
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

- **Exit codes:** `0` on success. `1` on a runtime error, when any database failed, when any `check` fails, or for `auth status` when not logged in. `2` on a usage error.
- **Error types:** `ConfigError` (config problems) and `AuthError` (not logged in, OAuth failure). Other errors carry plain messages.
  Messages are written to be acted on and name the env key, for example "SQL_DATABASES is empty".
- **Logs:** JSON lines on **stderr** and in the daily log file. Command output (results, lists) goes to **stdout**, so `--json` output can be piped.

### Testing approach

| Test file | Covers |
| --- | --- |
| `test/fake-drive.js` | In-memory fake of the Drive REST endpoints used by `DriveStore`. It can inject chunk failures that store half a chunk and then return 503 |
| `test/backup.test.js` | Orchestration with a fake SQL client that writes random bytes as the "`.bak`": partial failure, round trip, retention, checksum mismatch |
| `test/transform.test.js`, `test/review-fixes.test.js` | Encryption round trips at segment boundaries, plus tamper, truncation, reorder and wrong-key detection |
| `test/drive.test.js` | Folder creation and reuse, chunked upload and resume, list, download, delete, retry rules |
| `test/auth.test.js` | Token file permissions, the loopback server (good state, CSRF state, denial, timeout), the paste fallback and logout |
| `test/envconfig.test.js` | Env file parsing and mapping, env-key error messages, paths and `BACKUP_MANAGER_HOME` |
| `test/check.test.js` | Every `check` outcome with fake SQL/Google, SQL Express error explanations |
| `test/build-package.test.js` | Release build helpers (SHASUMS verification, `oauth-client.json`, Node version) |
| `test/config.test.js`, `naming`, `retention`, `mssql`, `logger`, `cli` | Unit tests for the pure parts, log files, CLI with `BACKUP_MANAGER_HOME` |

Testing patterns to reuse:
- `DriveStore` takes any `request(opts) → {status, data, headers}` function. In production that is `OAuth2Client#request`. In tests, use `createFakeDriveApi().request`.
- `MssqlClient` takes `{ driver }`. Fake `ConnectionPool` and `NVarChar` the way `test/mssql.test.js` does.
- Pass `logger: silentLogger` and a deterministic `now` to orchestration functions.

### How to make common changes

- **Add a setting.** Add the key to `ENV_KEYS` and map/validate it in `envToConfig` (`src/envconfig.js`) with an error
  that names the key; add internal validation in `normalizeConfig` if needed. Document it in the README settings table,
  add it to `packaging/backup-manager.env.template` if technicians should see it, and add cases to `test/envconfig.test.js`.
- **Add a CLI command.** Add a `case` in `main()` (`src/cli.js`), any new flags to `OPTIONS`, and a line in `USAGE`.
  Keep the logic in `src/backup.js`, or in a new module that takes injected dependencies, so it can be tested.
- **Add a storage backend** (S3, OneDrive, …). Implement the same surface `backup.js` uses from `DriveStore`:
  `ensurePath`, `resolvePath`, `listSubfolders`, `listBackups`, `getFile`, `uploadResumable`, `download` and `deleteFile`.
  Uploaded files must keep the `appProperties` semantics (or an equivalent metadata store).
- **Change the backup SQL.** Edit `buildBackupSql` and `buildVerifySql` in `src/mssql.js` and update `test/mssql.test.js`. Keep invariants 1 and 2.
- **Add notifications** (email, Slack). Hook into the result of `runBackups()` in the `backup` case of `cli.js`. Don't put them inside `backupOne`.
- **Change the Windows scripts.** Keep them pure ASCII and compatible with Windows PowerShell 5.1; CI parses them with 5.1.
  Under `irm | iex`, never call `exit` (it closes the technician's window): throw instead.

### Deliberately out of scope

- Web UI, Docker image, automatic `RESTORE DATABASE` into SQL Server (a `restore` command), key escrow, code signing,
  Windows Server/Linux/macOS targets, Windows Event Log, several SQL Server instances per machine, notifications and
  service-account auth.
- Differential and transaction-log backups. Every backup is a full `COPY_ONLY` backup.
- Per-database retention overrides. Retention is global and applied separately to each database's folder.

### Known follow-ups (non-blocking review notes)

- `createEncryptStream` and `createDecryptStream` concatenate each incoming chunk onto a pending buffer of up to 1 MiB. A chunk list
  with a running byte count would reduce memory copying on very large backups.
- The rate-limit 403 check reads `err.response.data` as JSON. For streamed downloads that is a stream, so
  rate-limit 403s during `download` are not retried.
- When an upload makes no progress (repeated 308 at the same offset), it retries immediately with no backoff.

## Development

Development happens on Linux with Node 22.

```bash
npm install
npm test                         # all unit tests (no SQL Server; only the logout tests reach Google's revoke endpoint)
node --test test/drive.test.js   # a single file

# run against a local env file instead of C:\ProgramData
export BACKUP_MANAGER_HOME=~/.config/backup-manager      # holds backup-manager.env, token.json, logs/
export BACKUP_MANAGER_OAUTH_CLIENT=./oauth-client.json   # Google "Desktop app" client JSON
node bin/backup-manager.js check

# build the release zip locally (needs network)
GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... npm run build:package
```

The internal JSON config (`-c backup-manager.json`, see `backup-manager.example.json`) still works for development
and is not documented for clients.

## Known issues

- The `.ps1` scripts can't be exercised in CI (they need Administrator, Task Scheduler and a real SQL Server);
  CI only checks that Windows PowerShell 5.1 parses them. Test a new release on a Windows VM before rolling it out.
