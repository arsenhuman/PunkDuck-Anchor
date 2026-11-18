# PunkDuck-Anchor: backup-manager

> **Technicians installing at a client: follow [INSTALL.md](INSTALL.md).** This README is the reference behind it.

A Windows program that takes **native SQL Server backups** (`BACKUP DATABASE ... TO DISK`) every night and uploads
them, compressed and encrypted, to the **client's own Google Drive**.

- **Target:** Windows 10/11 or Windows Server 2016 or newer, x64; SQL Server 2016 or newer (Express included). One SQL Server per machine.
- **Delivery:** a self-contained release zip (bundled `node.exe`, nothing to install beforehand), installed by
  **our team over RDP** with `install.ps1`. The installer also prepares SQL Server (login, permissions, mixed mode,
  TCP/IP); the only decision it asks for is whether SQL Server may be restarted now.
- **Scheduling:** Windows Task Scheduler, task **"PunkDuck Backup Manager"**, daily, as SYSTEM.
- **Monitoring:** Healthchecks.io, one check per client.
- **Restores:** always done by our team. See [RESTORE.md](RESTORE.md).

What one backup run does for each database:

1. Checks that the database exists and is `ONLINE`.
2. Runs `BACKUP DATABASE @db TO DISK = @path WITH CHECKSUM, COPY_ONLY, INIT, FORMAT`. The database name and path are
   passed as parameters and are never concatenated into the SQL. `COPY_ONLY` means the tool doesn't break the
   client's existing differential or log backup chain.
3. Runs `RESTORE VERIFYONLY ... WITH CHECKSUM`. SQL Server requires `CREATE DATABASE` permission in `master` for this,
   so the login needs it besides `db_backupoperator`.
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
pull request. On Windows it also makes Windows PowerShell 5.1 parse the `.ps1` scripts (and checks they are pure
ASCII), and runs `test/install-functions.ps1`: the pure functions of `install.ps1` and the rule that its T-SQL is
constant text.

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

Before you start, have ready:
- a Windows account that is a **SQL Server sysadmin** (normally the account that installed SQL Server), or the
  password of a sysadmin SQL login such as `sa`; otherwise see *SQL Server preparation*;
- a moment when a **~30 s SQL Server restart** is acceptable, in case mixed mode or TCP/IP still has to be enabled;
- the client's Gmail address and password, or the client at hand to sign in;
- the Healthchecks ping URL;
- access to the company password manager.

Open **Windows PowerShell as Administrator** and run:

```powershell
# TLS 1.2 first: Windows PowerShell 5.1 on Windows Server 2016 can't reach GitHub without it
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072

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
| `-RestoreOnly` | Restore machine for another client's backups: no SQL Server preparation or SQL checks, no scheduled task, no backup. See [RESTORE.md](RESTORE.md) |
| `-SkipSqlSetup` | Don't touch SQL Server (the client's DBA manages it): the DBA runs `sql-prepare.sql` instead, see *SQL Server preparation* |

The installer:

1. Checks for Administrator rights and Windows 10/11 or Windows Server 2016+ x64.
2. Downloads the zip and its `.sha256` (or takes them from `-ZipPath`) and verifies the hash.
3. Extracts to `C:\Program Files\backup-manager\` (only the program files are replaced).
4. If `backup-manager.env` doesn't exist, creates it from the template and opens it in **Notepad**. Fill in the lines
   marked `FILL IN`, save, close Notepad and press Enter.
5. If `BACKUP_ENCRYPTION_KEY` is empty, generates a key, writes it into the env file, copies it to the clipboard
   and **shows it once**.
   **Store it in the company password manager** under the client, then type `SAVED`.
6. Locks both folders down to SYSTEM and Administrators.
7. **Prepares SQL Server** (see *SQL Server preparation*): SQL login, permissions, SQL Browser, and, only after you
   type `RESTART`, mixed mode and TCP/IP.
8. Runs `backup-manager check` (without the Google part). On failure it stops with a plain-language explanation.
   Fix the env file and run the installer again; re-running is safe.
9. Runs `backup-manager auth login` if there is no working Google sign-in (see *Google sign-in*), then the full
   `check` again. It stops if the signed-in account is not `GOOGLE_EMAIL`.
10. Registers or updates the scheduled task "PunkDuck Backup Manager": daily at `BACKUP_TIME`, as SYSTEM with highest
    privileges, run as soon as possible after a missed start, 12-hour limit, no overlapping runs.
11. Runs the first backup and prints the result.

Whenever it stops, fix what it says and run it again: it keeps what you already entered and redoes only what is
still missing.

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

**The installer does this for you** (step 7), connected with your Windows account. It doesn't use TCP/IP or a SQL
login for this, so it works on a brand-new SQL Server Express. Your account must be a SQL Server **sysadmin**.
If it isn't, the installer asks for a sysadmin SQL login instead (Enter for `sa`). That only works when mixed mode
is already on. The password is kept in memory for step 7 only and never written to disk.

What it does, all safe to repeat:

1. Finds the SQL Server service from `SQL_INSTANCE` (`MSSQLSERVER` if empty, otherwise `MSSQL$<instance>`) and
   starts it if it is stopped. It skips the whole step if `SQL_HOST` is not this machine.
2. Checks that every database in `SQL_DATABASES` exists, is `ONLINE` and is writable, before it changes anything.
3. **The login.**
   - `SQL_USER` and `SQL_PASSWORD` **both empty** (the default): it creates the login `backup_user` with a random
     32-character password and writes both into the env file. The password is never shown. If `backup_user` already
     exists (e.g. the env file was deleted), its password is reset.
   - **Both set:** that login is used. An existing login is **not changed** (password, options); a login that doesn't
     exist yet is created with that password.
   - `SQL_USER` set, `SQL_PASSWORD` empty: a new login is created with a random password. If that login already
     exists, the installer stops: it never resets the password of a login it doesn't own. Enter its password, or
     empty `SQL_USER`.
   - `SQL_PASSWORD` set, `SQL_USER` empty: the installer stops.

   A login the installer creates is enabled, its default database is `master`, and password expiry is turned off,
   so an expiry policy can't silently stop the nightly backups.
4. **Permissions.** In `master`, a user with `CREATE DATABASE`: `RESTORE VERIFYONLY`, which checks every backup,
   needs it, and `db_backupoperator` is not enough. In every database, a user in `db_backupoperator`. A user left
   orphaned by a restore from another server is re-linked to the login.
5. **SQL Server Browser** (named instance, `SQL_PORT` empty or 1433): set to Automatic and started.
6. **Settings that need a SQL Server restart:** mixed-mode authentication, TCP/IP, and, for the default instance only,
   a static TCP port (`SQL_PORT`, normally 1433). A named instance keeps its ports. If the default instance already
   uses another static port, `SQL_PORT` is changed to match instead. **Firewall rules are never changed**: the
   program connects locally.

If anything in step 6 is needed, the installer lists it and asks:

```
Applying this RESTARTS the SQL Server service. Everyone using this SQL Server
(the client's application too) is disconnected for about 30 seconds.
Type RESTART to apply now, or press Enter to stop and run the installer again later:
```

- **Enter** stops the installer, and none of the step 6 settings are changed. (The login and permissions from
  steps 3 to 5 are kept; they don't disturb anything.) Run the installer again when a restart is OK.
- **`RESTART`** applies the settings, restarts SQL Server, starts SQL Server Agent and other services that depend
  on it again, and waits until SQL Server accepts connections (up to 90 s).

It ends with a summary (login created/kept, databases, settings changed, restart or not). A second run finds
nothing to change and does not ask again.

**When you have no sysadmin access at all** (no Windows sysadmin account and no `sa` password; e.g. the client's
DBA manages SQL Server), type `SKIP` at the login prompt and the installer stops at step 7. Then:

1. The DBA runs `C:\Program Files\backup-manager\sql-prepare.sql` in SSMS (it is commented; replace the login name,
   password and database name first) and enables mixed mode and TCP/IP if needed.
2. Put the password into `SQL_PASSWORD` in the env file.
3. Run the installer again with **`-SkipSqlSetup`**.

**`SQL_BACKUP_DIR`**: leave it empty and the installer fills it in with the instance's default backup folder
(`SERVERPROPERTY('InstanceDefaultBackupPath')`). With `-SkipSqlSetup` or SQL Server prepared by hand you fill it in
yourself: SSMS > server Properties > Database Settings > *Backup*, usually
`C:\Program Files\Microsoft SQL Server\MSSQL<nn>.<INSTANCE>\MSSQL\Backup`, where `<nn>` is 13 for SQL Server
2016, 14 for 2017, 15 for 2019, 16 for 2022 and 17 for 2025, and `<INSTANCE>` is the instance name (`MSSQLSERVER`
for a default instance).

**`SQL_DATABASES` and `SQL_INSTANCE`** have no defaults: every client names them differently. When Notepad opens,
the installer prints the SQL Server instances it finds on the machine, and if a database name is wrong it lists the
databases that do exist on that instance.

Common SQL Server traps, all detected by `backup-manager check`:

| Problem | Fixed by the installer | Manual fix |
| --- | --- | --- |
| **TCP/IP is disabled** (default on new installs, especially Express) | Yes, after `RESTART` | SQL Server Configuration Manager > SQL Server Network Configuration > Protocols > enable TCP/IP, restart the SQL Server service |
| **SQL Browser stopped** with a named instance (`SQL_INSTANCE=SQLEXPRESS`) | Yes | Start the "SQL Server Browser" service (Automatic), or set `SQL_PORT` to the instance's fixed port |
| **Mixed-mode authentication disabled** (Windows logins only) | Yes, after `RESTART` | SSMS > server Properties > Security > "SQL Server and Windows Authentication mode", restart |
| **Login failed** | Yes, if `SQL_USER` and `SQL_PASSWORD` are empty | Wrong `SQL_USER`/`SQL_PASSWORD`, or the login is disabled |
| **No verify permission** (Msg 262 + Msg 3013 "VERIFY DATABASE is terminating abnormally") | Yes | `GRANT CREATE DATABASE` in `master`, see `sql-prepare.sql` |
| **No BACKUP permission** | Yes | `db_backupoperator` in each database, see `sql-prepare.sql` |
| **Self-signed TLS certificate** | Not needed: trusted by default for a SQL Server on this machine | Remove `SQL_TRUST_SERVER_CERTIFICATE=false` from the env file |
| **No backup compression on Express** | Not needed | Nothing to do: native compression stays off and the program compresses with gzip |

### SQL Server on another machine

backup-manager normally runs on the SQL Server machine. It can also run on a different machine with only a SQL login
to the SQL Server, as long as a **network share** connects the two. `BACKUP DATABASE` always writes the `.bak` on
the SQL Server's own machine, and backup-manager has to read and delete that file.

What the client's IT sets up once on the SQL Server machine (there is no need to sign in to it after that):

1. Prepare SQL Server with `sql-prepare.sql` (login, permissions, mixed mode, TCP/IP). The installer can't do this
   for a remote SQL Server.
2. Share the backup folder, e.g. `D:\Backup` as `\\sqlhost\Backup`. SQL Server's service account writes there.
   The backup-manager machine needs **read and delete** rights on the share.
3. Allow TCP 1433 (or the instance's port) through the firewall from the backup-manager machine.

In the env file on the backup-manager machine:

```
SQL_HOST=sqlhost
SQL_USER=backup_user
SQL_PASSWORD=...
SQL_BACKUP_DIR=D:\Backup               # the folder as SQL Server sees it
SQL_LOCAL_BACKUP_DIR=\\sqlhost\Backup  # the same folder as this machine sees it
```

Then run the installer as usual. Step 7 only prints these instructions. `check` tests that the share is readable
and deletable, and the first backup proves that the two paths are really the same folder.

Limits:

- **The nightly task runs as SYSTEM.** On the network that is the computer account (`DOMAIN\<computer>$`), so
  the share must grant it rights, and this **only works in an Active Directory domain**. In a workgroup, SYSTEM
  can't sign in to another machine's share. `check` and the first backup during install run as you, so they can
  pass while the nightly run fails. Check the next morning's log.
- SQL Server's certificate is self-signed by default, and a remote connection doesn't trust it automatically. Add
  `SQL_TRUST_SERVER_CERTIFICATE=true` if `check` reports a certificate error.
- With no share at all (a SQL login is the only access), native `.bak` backups aren't possible.

## Settings: `backup-manager.env`

The env file is the **only** supported configuration. Format: `KEY=VALUE`, `#` starts a comment line.

The template, with instructions for the technician, is
[`packaging/backup-manager.env.template`](packaging/backup-manager.env.template). Fields the installer fills in
(`SQL_USER`, `SQL_PASSWORD`, `SQL_BACKUP_DIR`, `BACKUP_ENCRYPTION_KEY`) are left empty there.

| Key | Default | Meaning |
| --- | --- | --- |
| `SQL_HOST` | `localhost` | SQL Server host. For a SQL Server on another machine, also set `SQL_LOCAL_BACKUP_DIR` (see *SQL Server on another machine*) |
| `SQL_PORT` | `1433` | TCP port. With `SQL_INSTANCE` set, a value other than 1433 means "connect to this port directly, skip SQL Browser" |
| `SQL_INSTANCE` | (none) | Named instance: the part after `MSSQL$` in the service name, e.g. `SQLEXPRESS`. Empty for the default instance (`MSSQLSERVER`). Found through the SQL Browser service |
| `SQL_USER`, `SQL_PASSWORD` | filled in by the installer | SQL login. Leave both empty and the installer creates `backup_user` and writes both here; or enter an existing login and its password to use that one (see *SQL Server preparation*). A restore-only machine doesn't need them |
| `SQL_DATABASES` | required | Comma-separated database names, as shown in SSMS. A restore-only machine doesn't need it |
| `SQL_BACKUP_DIR` | filled in by the installer | Folder SQL Server writes backups to, as SQL Server sees it. A restore-only machine doesn't need it |
| `SQL_LOCAL_BACKUP_DIR` | `SQL_BACKUP_DIR` | Only for a remote `SQL_HOST`, and required then: the same folder as a network share seen from this machine, e.g. `\\sqlhost\Backup` |
| `SERVER_NAME` | computer name | Drive sub-folder name (`A-Z a-z 0-9 . _ -`) |
| `GOOGLE_EMAIL` | (none) | Expected Google account; used as the sign-in hint, and `check` fails if a different account is signed in |
| `BACKUP_TIME` | `02:00` | Daily start time (24-hour `HH:MM`), used by the installer for the scheduled task. Re-run the installer after changing it |
| `KEEP_LAST` / `KEEP_DAYS` | (none) | Retention: a backup is kept if it is one of the newest `KEEP_LAST` **or** younger than `KEEP_DAYS`. The newest backup is never deleted. With neither set, nothing is deleted |
| `HEALTHCHECK_URL` | (none: monitoring off) | Healthchecks.io ping URL, `https://` only |
| `BACKUP_ENCRYPTION_KEY` | required | 32-byte key, base64 or hex. **Never change it** after the first backup; old backups need the old key |
| `SQL_ENCRYPT` / `SQL_TRUST_SERVER_CERTIFICATE` | `true` / `true` for a SQL Server on this machine, else `false` | TLS to SQL Server (optional, not in the template). "This machine" means `SQL_HOST` is `localhost`, `127.0.0.1`, `::1`, `.`, `(local)` or the computer name. A value in the env file always wins |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` (optional) |

Rules:
- **Values containing `#` must be quoted with single quotes**, e.g. `SQL_PASSWORD='ab#12'`. An unquoted `#` is
  rejected rather than silently cutting the value. Don't use double quotes around Windows paths (`\n` would be
  turned into a line break).
- Unknown keys are reported as errors, so typos don't go unnoticed.
- Every error names the key to fix, e.g. `SQL_DATABASES is empty`.

## Google sign-in

`backup-manager auth login` (run by the installer) **opens the Google sign-in page in the default browser** and also
prints the URL. Add `--no-browser` to only print it.

- **With a browser on the machine:** sign in with the client's account in the window that opens and approve. Google
  redirects to a temporary `http://127.0.0.1:<port>` listener and the program finishes by itself.
- **Without a usable browser** (no browser window appears): open the printed URL on **your own laptop**, sign in with the
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
& $bm check --skip-sql                     # restore-only machine: everything except SQL Server and the backup folder
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
| `packaging/install.ps1`, `uninstall.ps1` | Windows install/update/uninstall (PowerShell 5.1, pure ASCII). `install.ps1` also prepares SQL Server (`Initialize-SqlServer`: `System.Data.SqlClient` over shared memory + the SQL Server WMI provider) | — |
| `packaging/backup-manager.cmd` | Launcher: runs `bin/backup-manager.js` with the bundled `node.exe` | — |
| `packaging/backup-manager.env.template` | Commented env file template copied by the installer | — |
| `packaging/sql-prepare.sql` | Manual SQL Server preparation for technicians who are not sysadmin (shipped in the zip) | — |
| `scripts/build-package.js` | Builds the release zip (downloads + verifies Node, `npm ci --omit=dev`, writes `oauth-client.json`) | `build`, `verifyShasum`, `oauthClientJson` |
| `bin/backup-manager.js` | Shebang wrapper: runs `main`, sets `process.exitCode`, prints `Error: …` for uncaught errors | — |
| `src/cli.js` | Argument parsing (`node:util` `parseArgs`), command dispatch, human/JSON output | `main`, `USAGE` |
| `src/envconfig.js` | Parses `backup-manager.env` (`util.parseEnv`), validates with env-key error messages, maps onto `normalizeConfig`; reads `oauth-client.json` | `loadEnvConfig`, `envToConfig`, `parseEnvText`, `isLocalSqlHost`, `ENV_KEYS` |
| `src/paths.js` | Program folder (`APP_ROOT`) and data folder (`BACKUP_MANAGER_HOME`, default `C:\ProgramData\backup-manager`) | `appHome`, `appPaths`, `APP_ROOT` |
| `src/check.js` | The `check` command: all checks with injected I/O (`skipAuth`, `skipSql`), SQL error explanations with the exact fix SQL | `runChecks`, `explainSqlError`, `formatChecks`, `verifyGrantFix` |
| `src/config.js` | Validates and applies defaults (`normalizeConfig`); internal JSON loader (`-c`, development only) | `loadConfig`, `normalizeConfig`, `ConfigError`, `parseEncryptionKey` |
| `src/auth.js` | OAuth installed-app flow (loopback + PKCE + state, plus paste fallback), token file I/O, status, logout/revoke | `login`, `status`, `logout`, `getAuthorizedClient`, `startLoopbackServer`, `parsePastedRedirect` |
| `src/mssql.js` | SQL text builders + `MssqlClient` wrapper (connect, online check, BACKUP and verify permission, version, BACKUP, VERIFYONLY); `formatSqlError` prints every server message (`err.precedingErrors`) | `MssqlClient`, `buildBackupSql`, `buildVerifySql`, `toPoolConfig`, `formatSqlError`, `sqlErrorNumbers` |
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
            3. sqlClient.verify(serverPath)              RESTORE VERIFYONLY FROM DISK=@path WITH CHECKSUM (needs CREATE DATABASE in master)
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
10. **The installer's T-SQL is constant text.** In `install.ps1`, every `Invoke-SqlAdmin -Sql` argument is a top-level
    single-quoted `$Sql*` constant. Login names, database names and the password go in only as `SqlParameter`s; DDL
    that can't take parameters is built inside T-SQL with `QUOTENAME()` and run with `sp_executesql`.
    `test/install-functions.ps1` enforces this.
11. **The installer never restarts SQL Server unasked and never changes the firewall.** A restart happens only after
    the technician types `RESTART`; Enter changes nothing that needs a restart.
12. **SQL error messages are complete.** Print or log SQL errors through `formatSqlError` (the logger does it for
    every `Error`): the real cause (e.g. Msg 262) is often in `precedingErrors`, not in the final message.

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
- **SQL errors** are printed and logged with every server message in order (`formatSqlError`), e.g.
  `Msg 262: CREATE DATABASE permission denied in database 'master'. | Msg 3013: VERIFY DATABASE is terminating abnormally.`
  In `check`, a SQL error after a successful connection is shown as its own "SQL error" row.
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
| `test/check.test.js` | Every `check` outcome with fake SQL/Google (including verify permission and `--skip-sql`), SQL error explanations (262 behind 3013) |
| `test/install-functions.ps1` | Pure functions of `install.ps1` (password generator, instance resolution, local host, port plan, WMI namespace) and invariant 10. Windows PowerShell 5.1 in the Windows CI job; it loads only the function definitions via the AST |
| `test/build-package.test.js` | Release build helpers (SHASUMS verification, `oauth-client.json`, Node version), packaging files present and pure ASCII |
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
  Under `irm | iex`, never call `exit` (it closes the technician's window): throw instead. Put logic you can test
  without SQL Server into small pure functions and cover them in `test/install-functions.ps1`. New T-SQL goes into a
  top-level `$Sql*` single-quoted constant (invariant 10).

### Deliberately out of scope

- Web UI, Docker image, automatic `RESTORE DATABASE` into SQL Server (a `restore` command), key escrow, code signing,
  Linux/macOS targets, Windows Server older than 2016 and 32-bit/ARM Windows (the bundled Node 22 doesn't run there), Windows Event Log, several SQL Server instances per machine, notifications and
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

Development happens on Linux with Node 22 (`nvm use` picks it up from `.nvmrc`; with Node 18, `npm test` finds no tests).

```bash
npm install
npm test                         # all unit tests (no SQL Server; only the logout tests reach Google's revoke endpoint)
node --test test/drive.test.js   # a single file
# install.ps1 functions (Windows PowerShell 5.1; CI runs this on windows-latest)
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\install-functions.ps1

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

- The `.ps1` scripts can't be run end to end in CI (they need Administrator, Task Scheduler and a real SQL Server).
  CI checks that Windows PowerShell 5.1 parses them and tests the pure functions of `install.ps1`, but the SQL Server
  preparation (SqlClient, WMI, service restart) is only tested by hand. Test a new release on a Windows VM with a
  fresh SQL Server Express before rolling it out (checklist: `docs/sql-setup-plan.md`, section 8).
