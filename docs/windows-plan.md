# Windows packaging plan (phase B)

Status: **implemented** on branch `feat/windows-packaging`. This file records the decisions behind the Windows-only
product. The user-facing documentation is in the README and [RESTORE.md](../RESTORE.md); where they differ from this
plan, see *Implementation notes*.

Builds on branch `chore/node22-deps`: Node 22 LTS, `mssql@12`, `google-auth-library@11`, `node-cron@4`, 83 tests.

## Target platform

- **Windows 10/11 x64 only**, PowerShell 5.1. Windows Server, Linux and macOS are not targets.
- **SQL Server 2016 or newer, including Express.**
- Development still happens on Linux. Unit tests must pass on Linux, and Windows behaviour is verified in CI.

## Delivery model

- **No Docker.** Linux containers need WSL2 or Hyper-V, which is often unavailable on client machines. Windows
  containers are multi-GB and tied to the exact OS build. The container would still need the SQL backup folder
  mounted from the host, so it isolates nothing. And it puts a large burden on the client's IT.
- **No `git clone` + `npm install` on client machines.** That would need Git, Node and npm on every machine, a GitHub
  token stored on each one if the repo is private, and installs that can break when the npm registry changes.
- **A self-contained release zip instead:** `backup-manager-<version>-win-x64.zip`, containing:
  - the official portable `node.exe`;
  - the app (`bin/`, `src/`, `package.json`, lockfile);
  - production `node_modules`;
  - `oauth-client.json`;
  - the env template;
  - the install and uninstall scripts;
  - a `backup-manager.cmd` launcher.

  Nothing needs to be installed on the client beforehand.
- **The zip is public,** published as a GitHub Release asset. It contains no secrets: a desktop OAuth client ID is not
  treated as confidential by Google. The rest of the code can stay as it is.
- **Our team installs it over RDP.** Clients do not install it themselves.

## Install flow (`install.ps1`)

Run in PowerShell **as Administrator**:

```powershell
# latest release
irm https://github.com/<owner>/PunkDuck-Anchor/releases/latest/download/install.ps1 | iex

# pinned version (download install.ps1 first)
.\install.ps1 -Version 1.2.0
```

Steps:

1. Check for administrator rights and Windows 10/11 x64.
2. Download the zip and its `.sha256`, and verify the hash.
3. Extract to `C:\Program Files\backup-manager\`. Only the program files are replaced.
4. If `C:\ProgramData\backup-manager\backup-manager.env` doesn't exist, create it from the commented template,
   open it in **Notepad**, and wait for the technician to fill it in.
5. If `BACKUP_ENCRYPTION_KEY` is empty, generate a key, write it into the env file, and **show it once**
   (see *Encryption*).
6. Lock down the folders with `icacls` (see *ACLs*).
7. Run `backup-manager check`. On failure, stop with a plain-language message. Re-running the installer is safe.
8. Run `backup-manager auth login` if there is no valid token.
9. Register or update the scheduled task (see *Task Scheduler*).
10. Run the first backup and print the result.

**Update:** run the installer again. It keeps the env file and the token.

**Uninstall (`uninstall.ps1`):** removes the scheduled task and the program folder, and keeps `C:\ProgramData\backup-manager`.
With `-Purge`, it also deletes ProgramData and revokes the Google token. **Backups on Google Drive are never touched.**

## Configuration: the env file

- **The env file is the only supported config interface.** It lives at `C:\ProgramData\backup-manager\backup-manager.env`.
- Its format is `KEY=VALUE` with `#` comments. Node's built-in env-file parsing reads it, so `dotenv` is not needed.
- The env values are mapped onto the existing `normalizeConfig`. The JSON loader stays **internal only** and is not
  documented for clients.
- One SQL Server per machine.
- Errors name the env key, for example `SQL_DATABASES is empty`.

Template:

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

## Paths

| What | Path |
| --- | --- |
| Program | `C:\Program Files\backup-manager\` |
| Env file | `C:\ProgramData\backup-manager\backup-manager.env` |
| Google token | `C:\ProgramData\backup-manager\token.json` |
| Logs | `C:\ProgramData\backup-manager\logs\backup-YYYY-MM-DD.log` |
| Scratch | `C:\ProgramData\backup-manager\work\` |

All of `C:\ProgramData\backup-manager\` can be moved with the `BACKUP_MANAGER_HOME` env var, which the tests use.

## Google OAuth

- **One company-owned OAuth client** of type *Desktop app*. Each client signs in with **their own** Google account,
  and backups go to **their own** Drive. Our company has no access to any client's Drive.
- **Scope `drive.file` only.** The app sees only the files and folders it created.
- **Set up once in Google Cloud:**
  1. Create a project and enable the Drive API.
  2. Configure the OAuth consent screen as *External*.
  3. **Publish to production.** In *Testing* mode, sign-ins expire after 7 days.
  4. Don't upload a logo, because a logo triggers brand verification. `drive.file` is non-sensitive, so no
     security review is needed.
- **Bundling:** `oauth-client.json` is generated **at build time** from the GitHub repository secrets
  `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`. It is never committed.
- **Sign-in fallback** for machines without a usable browser:
  1. `auth login` prints the URL, and the technician opens it on their own laptop and signs in.
  2. They copy the final `http://127.0.0.1:…` address (the page itself fails to load, which is expected) and
     paste it, or just the code, into the RDP console.
  3. State and PKCE are still verified.

  The normal loopback flow keeps working when a local browser is available.
- **Avoiding OAuth was ruled out:**
  - Google doesn't allow passwords for Drive API access.
  - Service accounts have no storage quota for personal Gmail.
  - Google Drive for desktop is unsupported for this use and only syncs while a user is logged in.
  - rclone still uses OAuth.
- **If a client revokes access,** uploads stop and Healthchecks alerts us. The fix is to run `auth login` again.

## Encryption

- **On by default** (AES-256-GCM, segmented `BMENC2` format; unchanged).
- **Company-managed key:**
  - The installer generates the key if it's empty and **shows it once**, and we **store it in the company password manager**.
  - The key also stays in the env file on the machine, which is ACL-protected, because nightly backups need it.
- **Restores are always done by our team** with `backup-manager download`. Restoring into SQL Server is a manual step.
- If the key is lost, that client's backups can't be restored.

## Task Scheduler (replaces `node-cron`)

- The `schedule` command and the `node-cron` dependency are **removed**. That leaves `mssql` and `google-auth-library`.
- The task is named **"PunkDuck Backup Manager"** and runs `backup-manager.cmd backup` daily at `BACKUP_TIME`.
- It runs as **SYSTEM** with highest privileges.
- **Run as soon as possible after a missed start:** enabled.
- **Execution time limit:** 12 hours.
- **Overlapping instances:** not allowed.

## Logs

- Each run appends JSON lines to `logs\backup-YYYY-MM-DD.log` and also writes to stderr. The existing redaction
  of secrets is kept.
- Log files older than 30 days are deleted at the start of each run.

## ACLs

- `icacls` on `C:\ProgramData\backup-manager\` removes inheritance and grants full control **only to SYSTEM and
  BUILTIN\Administrators**. The same applies to the install folder.
- This replaces the Unix 0600/0700 modes in the code, which Windows ignores.

## `check` command and SQL Express traps

`backup-manager check` verifies the following, explains each failure in plain words, and exits 0 only if all checks pass:

- The env file is valid.
- The SQL connection works.
- Each database exists and is `ONLINE`.
- The login has BACKUP permission (`HAS_PERMS_BY_NAME`).
- The backup folder exists and is readable and deletable by this process.
- The Google token works, and it shows which account is signed in.
- The Healthchecks URL has a valid format.

It recognizes these common problems:

- **TCP/IP is disabled.** This is the SQL Express default. Fix: enable it in SQL Server Configuration Manager and
  restart the service.
- **The SQL Browser service is stopped** while a named instance is used. Fix: start the service, or set `SQL_PORT`.
- **Mixed-mode authentication is disabled** (Windows logins only, often the case on Express). Fix: enable "SQL Server
  and Windows Authentication mode" and restart.
- **Login failed** (wrong user or password, or the login is disabled).
- **Express has no backup compression.** `nativeCompression` stays off, and gzip in the tool is used instead.

## Monitoring (Healthchecks.io)

- This was already implemented on `feat/healthchecks-heartbeat`, with one check per client.
- **Agreed settings: Period = 1 day, Grace = 4 days**, so an alert fires after 5 days with no successful backup.
- The URL is set with `HEALTHCHECK_URL` in the env file. A ping is sent only when every database succeeded.

## Releases and CI (GitHub Actions)

- **`ci.yml`:** on every push and pull request, runs `npm ci` and `npm test` on `windows-latest` and `ubuntu-latest`.
- **`release.yml`:** runs on tags `vX.Y.Z`, on the Windows runner. It:
  1. runs `npm ci` and `npm test`, which **must pass before anything is published**;
  2. checks that the tag matches the `package.json` version;
  3. runs `scripts/build-package`, which downloads the official Node 22 win-x64 build, verifies `SHASUMS256`, runs
     `npm ci --omit=dev`, and bundles everything with `oauth-client.json` built from the secrets;
  4. creates a GitHub Release with the zip, its `.sha256` and `install.ps1`.
- `install.ps1 -Version X.Y.Z` installs a pinned release. Without `-Version`, it installs the latest.

## Deferred (not in phase B)

- **A `restore` command** (automatic `RESTORE DATABASE` into SQL Server). Today restores are done by
  `download` plus a manual `RESTORE`.
- **Key escrow:** a formal system for storing and recovering encryption keys. For now the key is shown once
  at install and kept in the company password manager.
- Code signing of the scripts and `node.exe` wrapper, a GUI, Windows Server support, Windows Event Log integration,
  and several SQL Server instances per machine.

## Resolved questions

1. **Healthchecks grace period:** Period 1 day / Grace 4 days (alert after 5 days of silence).
2. **`RESTORE.md`:** yes, as a **team runbook** (download + manual `RESTORE DATABASE`), part of phase B.
3. **"Also include" list:** dropped.
4. **Approval:** the phase-B prompt was approved and implemented.

## Implementation notes

Details decided during implementation that the plan above did not spell out:

- **Named instance vs. port.** The template pre-fills `SQL_PORT=1433`. With `SQL_INSTANCE` set, the instance is found
  through SQL Browser unless `SQL_PORT` is set to something other than 1433 (then that port is used directly).
- **Extra optional keys** (not in the template): `SQL_ENCRYPT`, `SQL_TRUST_SERVER_CERTIFICATE` (SQL Express uses a
  self-signed certificate; `check` suggests this when the TLS handshake fails) and `LOG_LEVEL`.
- **Strict env file.** Unknown keys are errors (typos), and an unquoted value containing `#` is rejected because
  `util.parseEnv` would silently cut it there (passwords). A UTF-8 BOM is stripped.
- **`check --skip-auth`.** Step 7 of the installer runs before the first Google sign-in (step 8), so the installer
  skips the Google check there. `check` also verifies SQL Server is 2016+ and that the work folder is writable, and
  fails if the signed-in account differs from `GOOGLE_EMAIL`.
- **Paste fallback.** A pasted address is state-checked. A pasted bare code has no state to check; it is still bound to
  this login by PKCE and the loopback `redirect_uri`.
- **Installer extras:** `-RestoreOnly` (no task, no backup: for restore machines, see RESTORE.md); `-ZipPath` for offline installs (with the `.sha256` next to it); refuses to update while the
  task is running; asks the technician to type `SAVED` after the key is shown; waits for Enter after Notepad (Windows
  11 Notepad can return immediately); ACLs use SIDs so they work on any Windows language; the data folder is locked
  before any secret is written to it.
- **Build:** `scripts/build-package.js` uses `adm-zip` (dev dependency only) to read the Node zip and write the
  release zip on both Windows and Linux. The bundled Node version is the one running the build (must be 22.x), or
  `NODE_DIST_VERSION`.
- **Log file dates** use the machine's local date.
