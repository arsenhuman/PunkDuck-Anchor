# v0.1.1 plan: installer prepares SQL Server + P1 fixes

Status: **approved 2026-11-18** (decisions in section 9). Branch: `feat/sql-setup`, PR into `main`.

Goal: on a fresh SQL Server Express machine, the technician running `install.ps1` over RDP makes **one decision**
(restart SQL Server now or later) instead of doing the SQL fixes by hand.

## 0. Findings from the code that change or refine the brief

1. **Base branch.** The origin had no `main`. **Resolved:** `main` was created on GitHub at
   `feat/windows-packaging` (28267a9, a superset of v0.1.0 that has the latest README). `feat/sql-setup` starts there.
2. **`npm test` requires Node 22.** The machine default `node` is 18 and cannot expand the `test/*.test.js` glob.
   **Resolved:** an `.nvmrc` with `22` is added in stage 1.
3. **Where `precedingErrors` lives.** `mssql` (not tedious directly) sets `err.precedingErrors` on the final
   `RequestError` (`node_modules/mssql/lib/tedious/request.js`), and each entry has `number` and `message`. For the
   verify failure, the outer error is **3013** and **262** is in `precedingErrors`. So `explainSqlError` must look at
   the whole chain, not only `err.number`.
4. **The logger drops `precedingErrors`.** `redact()` turns an `Error` into `{ name, message, code }`, so today the
   log line for a failed verify shows only "VERIFY DATABASE is terminating abnormally." Fix: `redact()` uses the new
   helper for the message. Redaction of the message stays (`redactString` runs on the formatted text).
5. **`SQL_PASSWORD` empty is a settings error today** (`envToConfig`: "SQL_PASSWORD is empty"). That's still correct,
   because the installer fills the password in before `check` runs. I'll change the text to
   "SQL_PASSWORD is empty (the installer creates the login and fills it in; run it again)".
6. **Instance resolution must mirror `envToConfig`.** Node treats `SQL_INSTANCE` as a Browser lookup only when
   `SQL_PORT` is empty or 1433. Any other port means "connect to that port directly". The installer uses the same rule:
   - The **service** is always `MSSQL$<SQL_INSTANCE>` when `SQL_INSTANCE` is set (else `MSSQLSERVER`).
   - **SQL Browser** is ensured only when Node will actually use it (named instance + port empty/1433).
7. **`.` and `(local)` as `SQL_HOST`.** F3 treats these as local, but tedious resolves the host over DNS, so it can't
   connect to `.` or `(local)`. `check` already reports `ENOTFOUND` with "Use localhost". I'll leave the connection
   behaviour as is. F3 and the installer both treat these names as local, so the technician gets the clear
   `check` message instead of the installer skipping SQL preparation.
8. **The "Login failed" and missing-BACKUP-permission fixes in `check.js`** point to SSMS steps. They'll name the
   installer re-run and `sql-prepare.sql` instead (same F7 neutral wording, no "Express").

## 1. Part 1: P1 fixes in the Node app (stage 1, one commit)

### F2: `formatSqlError(err)` in `src/mssql.js`
- `[...(err.precedingErrors ?? []), err]`, each rendered as `Msg <number>: <message>` (or just `message` without a
  number), joined with ` | `. Non-SQL errors return `err.message` unchanged.
- Used in:
  - `backup.js` (`runBackups` result `error` for both connect and per-DB failures);
  - `check.js` (fallback "SQL Server error: ..." text);
  - `logger.redact()` (message of every logged `Error`, still passed through `redactString`).
- `sqlErrorNumbers(err)`: a small helper returning all numbers in the chain, used by `explainSqlError`.

### F1: verify permission
- `MssqlClient.canCreateDatabase()`: `SELECT HAS_PERMS_BY_NAME('master','DATABASE','CREATE DATABASE')`, which is a
  constant query with no parameters. `check` runs it **once per server** after the connection, as a new row
  "Verify permission". On failure it fails with:
  `GRANT CREATE DATABASE in master is missing (RESTORE VERIFYONLY needs it)`, and the fix gives the exact SQL:
  `USE master; CREATE USER [backup_user] FOR LOGIN [backup_user]; GRANT CREATE DATABASE TO [backup_user];`, with
  the real `SQL_USER` and `]` escaped. The fix also says "or run the installer again / `sql-prepare.sql`".
  On a connection failure, the row is marked skipped like the DB rows.
- `explainSqlError`: if 262 is anywhere in the chain, it explains it the same way.
- `packaging/sql-prepare.sql` (new): a commented manual script for technicians who are not sysadmin.
  - It covers: `CREATE LOGIN ... CHECK_EXPIRATION = OFF, DEFAULT_DATABASE = master`, the user in `master` with
    `GRANT CREATE DATABASE`, and the user and `db_backupoperator` in one example DB (`Sales`), with "repeat for each
    DB" comments.
  - It also has commented notes on mixed mode and TCP/IP (those need a DBA/admin anyway).
  - Literal placeholders (`backup_user`, `<strong password>`, `Sales`) for SSMS use; no SQLCMD mode needed.
- `scripts/build-package.js`: add `sql-prepare.sql` to `PACKAGING_FILES` (CRLF like the others), and update its test.
- README "SQL Server preparation" is rewritten in stage 3, together with the installer.

### F3: trust the certificate for a local SQL Server by default
- `isLocalSqlHost(host, hostname)` in `envconfig.js`. Local means one of:
  - `localhost`, `127.0.0.1`, `::1`, `.`, `(local)`;
  - equal (case-insensitive) to `os.hostname()` or `process.env.COMPUTERNAME`.
- The default for `SQL_TRUST_SERVER_CERTIFICATE` is `isLocal`, and an explicit `true`/`false` always wins (the existing
  `flag()` already does that). `SQL_ENCRYPT` stays `true`: the connection is still encrypted, only the cert chain
  isn't validated, which is fine for a loopback connection.
- README settings table updated.

### F7
- Make `check.js` texts neutral, for example: "SQL Server uses a self-signed certificate by default", and "TCP/IP is
  probably disabled (the default on new installs, especially Express)".
- The cert fix text no longer needs to tell people to add the setting for local servers (it's the default now).
  It says to set `SQL_TRUST_SERVER_CERTIFICATE=true` only if the env file has it set to `false`.

### Node tests (no real SQL Server or Google, as before)
- `mssql.test.js`: `formatSqlError` with and without `precedingErrors` and with a non-SQL error; the CREATE DATABASE
  query is constant.
- `check.test.js`:
  - the "Verify permission" pass and fail paths;
  - the fix SQL escapes `]` in the login name;
  - `explainSqlError` for 262 as the outer error and as a preceding one;
  - the neutral cert wording.
- `envconfig.test.js`: local host list and the computer name (case-insensitive) give `true`; a remote host gives
  `false`; explicit `false` on localhost and explicit `true` on a remote host win.
- `logger.test.js`: a logged error with `precedingErrors` shows both messages, and a token in a preceding message is
  still redacted.
- `backup.test.js`: a verify failure with 262 + 3013 shows both in `results[].error`.
- `build-package.test.js`: the zip includes `sql-prepare.sql` (CRLF).

## 2. Part 2: installer step "Preparing SQL Server" (stages 2 and 3)

### Flow (11 steps)
| # | Step |
|---|---|
| 1 | Checking prerequisites |
| 2 | Getting the release package |
| 3 | Installing program files |
| 4 | Settings (env file) |
| 5 | Encryption key |
| 6 | Restricting folder access |
| **7** | **Preparing SQL Server** (new) |
| 8 | Checking settings, SQL Server and backup folder (`check --skip-auth`) |
| 9 | Google sign-in + full `check` |
| 10 | Scheduled task (skipped with `-RestoreOnly`) |
| 11 | First backup (skipped with `-RestoreOnly`) |

The Notepad hint in step 4 adds: "Leave SQL_PASSWORD empty: the installer creates the SQL login."

### New switches
- `-SkipSqlSetup`: the step makes no connection and no changes. It prints "SQL Server preparation skipped. The
  DBA must run `C:\Program Files\backup-manager\sql-prepare.sql` (see README)" and continues to `check`.
- `-AllowSqlRestart`: **not added** (decision 5). Installs are always interactive. It's a possible later addition:
  one `param` plus one `-or` in the prompt.

### `-RestoreOnly` (decision 2: no SQL preparation)
A restore machine needs only Google, the key and `download`. The restore itself is done by hand in SSMS, and the
client's databases don't exist there yet. So:
- In `-RestoreOnly` mode, step 7 prints "skipped (restore-only)", and steps 8 and 9 run
  `check --skip-auth --skip-sql` and `check --skip-sql`.
- New **`check --skip-sql`** skips the SQL connection, the verify permission, the databases and the backup folder.
  These rows show as `--` skipped. The settings, work folder, Google and Healthchecks rows are still checked.
- **Needed for this to work (found while planning):** settings loading itself rejects an empty `SQL_PASSWORD`, which
  breaks `check --skip-sql`, `list` and `download` on a restore machine. So `SQL_PASSWORD` must be non-empty only for
  commands that use SQL: `backup`, and `check` without `--skip-sql`. `loadEnvConfig(paths, { requireSql })` handles
  this. All other SQL_* values are still validated when they are present. The template's non-empty defaults for
  `SQL_USER`, `SQL_DATABASES` and `SQL_BACKUP_DIR` keep loading working without edits.
- RESTORE.md "Restoring elsewhere": the SQL_* settings can stay as in the template and no longer need to pass `check`.

### Pure functions (PowerShell 5.1, ASCII only)
- `Test-LocalSqlHost $SqlHost`: the same list as Node, plus `$env:COMPUTERNAME`, case-insensitive.
- `Resolve-SqlInstance $SqlHost $Instance $Port` returns `@{ ServiceName; DataSource; InstanceName; IsNamed; NeedsBrowser }`:
  - `ServiceName`: `MSSQLSERVER` or `MSSQL$X`;
  - `DataSource`: `lpc:.` or `lpc:.\X`;
  - `NeedsBrowser`: true for a named instance with port empty or 1433 (finding 6).
- `New-SqlLoginPassword`: 32 characters from `[A-Za-z0-9]`, from `RNGCryptoServiceProvider` with rejection sampling
  (no modulo bias). It retries until it has at least one upper, one lower and one digit.
- `Test-SqlLoginName`: rejects an empty name, `\`, control characters, and names longer than 128. `SQL_USER` must be
  a SQL login, not `DOMAIN\user`.

### What the step does
1. **Read the env values** `SQL_HOST`, `SQL_INSTANCE`, `SQL_PORT`, `SQL_USER`, `SQL_PASSWORD` and `SQL_DATABASES`
   with `Get-EnvValue`.
   - If the host is not local: print "SQL Server is not on this machine, skipping" and continue.
   - If the service (`Get-Service`) doesn't exist: stop and list the `MSSQL*` services that do exist, so the
     technician can fix `SQL_INSTANCE`.
   - If the service is stopped, start it (it isn't a restart, so nobody is disconnected).
2. **Connect** via `Invoke-SqlAdmin -Sql <const> -Params @{...} [-Database x]`, which wraps
   `System.Data.SqlClient` with `Data Source=lpc:.\X; Integrated Security=SSPI; Encrypt=False; Connect Timeout=15`.
   All values are passed as `SqlParameter` (`NVarChar`). It returns `DataTable` rows or a scalar.
3. **Sysadmin:** `SELECT IS_SRVROLEMEMBER('sysadmin')`. If it isn't 1, or the connection fails, print:
   - who we connected as (`SUSER_SNAME()` when the connection works);
   - what is needed;
   - the path to `sql-prepare.sql` and `-SkipSqlSetup`.

   Then stop with "fix and run the installer again".
4. **Check the databases** before changing anything. Every DB in `SQL_DATABASES` must exist, be `ONLINE`, and not be
   read-only (a user can't be created in a read-only DB). Otherwise the step stops and names the DB. This runs before
   any login or grant is created, so a typo in `SQL_DATABASES` doesn't leave half the setup done.
5. **Login.** If a login with that name exists but isn't a SQL login (type `S`), stop.
   - **`SQL_PASSWORD` empty:** generate a password. Then either `CREATE LOGIN` (if the login doesn't exist) or
     `ALTER LOGIN ... WITH PASSWORD` (if it does). After that succeeds, `Set-EnvValue SQL_PASSWORD`. Doing it in this
     order means a failure can never leave a password in the env file that SQL Server doesn't know. A re-run then
     simply generates a new one.
   - **`SQL_PASSWORD` set:** the password isn't touched. If the login is missing, stop (decision 4) with "SQL_PASSWORD
     is set but login X does not exist. Empty SQL_PASSWORD in the env file and run the installer again to let it
     create the login."
   - **Always:** `ALTER LOGIN ... WITH CHECK_EXPIRATION = OFF, DEFAULT_DATABASE = [master]`, then `ALTER LOGIN ... ENABLE`.
     `CHECK_POLICY` stays ON.
   - The password is never printed or logged, and isn't kept in a variable longer than needed.
6. **Grants** use one constant T-SQL text per DB, run in that DB's context through
   `EXEC @proc` with `@proc = QUOTENAME(@db) + N'.sys.sp_executesql'`. Inside it:
   - Find a user with the login's SID (`SUSER_SID(@login)`):
     - if one exists under any name, use that name;
     - if it's `dbo`, nothing is needed: dbo already has all permissions.
   - Otherwise, if a user named `@login` exists with another or orphaned SID, run `ALTER USER <q> WITH LOGIN = <q>`.
   - Otherwise run `CREATE USER <q> FOR LOGIN <q>`.
   - Then: in `master`, `GRANT CREATE DATABASE TO <q>`. In each DB, `ALTER ROLE db_backupoperator ADD MEMBER <q>`,
     only if it isn't a member yet.
   - Each step returns a status word (created, remapped, kept) for the summary.
7. **Settings that need a restart.** All of these are detected first, and nothing is written yet:
   - Mixed mode: `SERVERPROPERTY('IsIntegratedSecurityOnly') = 1`. Fix: the `xp_instance_regwrite ... LoginMode, 2`
     from the brief.
   - TCP/IP:
     - Find the namespaces with `Get-CimInstance -Namespace root\Microsoft\SqlServer -ClassName __NAMESPACE`, keep
       those matching `ComputerManagement(\d+)`, and take the highest number.
     - Then read `ServerNetworkProtocol` where `InstanceName = <MSSQLSERVER|X>` and `ProtocolName = 'Tcp'`, and fix it
       with `Invoke-CimMethod SetEnable`.
     - If there's no namespace or no matching row, stop with the Configuration Manager instructions.
   - Port, default instance only:
     - Read `ServerNetworkProtocolProperty` with `IPAddressName = 'IPAll'`.
     - If `TcpPort` is empty, set `TcpPort = SQL_PORT` and `TcpDynamicPorts = ''` (`SetStringValue`).
     - **If it already has a static port different from `SQL_PORT`, keep it and write `SQL_PORT=<that port>` into
       the env file, and print it** (decision 3).
   - Named instance: leave ports alone. If `NeedsBrowser` is true, set `SQLBrowser` to Automatic and start it
     (no SQL Server restart needed). This happens without a prompt.
   - No firewall changes, ever.
8. **Restart prompt** (only if mixed mode, TCP or the port needs changing). The step lists the exact changes, then
   shows the prompt from the brief.
   - **Enter (or anything but `RESTART`):** nothing has been written at that point. The step stops with "Nothing
     was changed in the SQL Server settings. Run the installer again when a restart is OK."
     The login and grants from steps 5 and 6 stay in place. They are harmless and don't need a restart, and the
     re-run is idempotent.
   - **`RESTART`:**
     - Apply the settings.
     - Record which `DependentServices` are running (e.g. SQL Server Agent or Launchpad).
     - `Stop-Service -Force`, then `Start-Service` on the SQL Server service, then start the recorded dependents again.
     - Poll an `lpc:` connection every 3 s for up to 90 s. On timeout, stop with "SQL Server did not come back
       within 90 s; check services.msc and the SQL Server error log".
     - If applying a setting fails halfway, the step stops before the restart and says what was applied.
       Re-running is safe, because the detection runs again.
9. **Summary.** For example:
   `Login backup_user: created (password stored in the env file) | Databases: Sales (user created), HR (kept) |
   CREATE DATABASE in master: granted | Settings: mixed mode enabled, TCP/IP enabled, port 1433 | SQL Server restarted`.

### Security invariants (also added to README "Invariants")
- Every T-SQL text in `install.ps1` is a **constant string**. Login names, DB names and the password go in only as
  `SqlParameter`s. DDL that can't take parameters is built **inside T-SQL** with `QUOTENAME()` and run with
  `sp_executesql`. The password is additionally escaped with `QUOTENAME(@pw, '''')`. A test greps `install.ps1` for
  the ways a name could get into SQL text: string interpolation or `+` concatenation inside `Invoke-SqlAdmin -Sql`
  arguments.
- No firewall rules. No restart unless the technician types `RESTART`.
- The password is never written to the console or a transcript.

## 3. PowerShell tests: tradeoff

`install.ps1` must stay one file (it runs under `irm | iex`), so its functions can't simply be dot-sourced. A test
can parse it with the PowerShell AST, define only the `function` blocks, and test the pure functions without running
the installer.

| Option | Cost | Value |
|---|---|---|
| **A. Plain PS 5.1 test script** (`test/install-functions.ps1`, AST-loads functions, simple asserts, exit 1 on failure), one step in the existing Windows CI job | ~2 s CI, no new dependency | Covers the password generator (charset, length, classes, no `#` or quotes over 1000 runs), instance resolution, local-host detection, login-name validation, and the constant-SQL grep |
| B. Pester 5 | `Install-Module Pester -RequiredVersion 5.x` from PSGallery on every CI run (+20-30 s, a network/supply-chain dependency) | Same coverage, nicer output |
| C. Built-in Pester 3.4 | Free, but old syntax that Pester 5 doesn't support | Same coverage |

**Decision 6: A.** Functions are loaded with `System.Management.Automation.Language.Parser::ParseFile`, and only the
`FunctionDefinitionAst` nodes are defined, so nothing in the install flow runs.
Nothing that touches SQL, WMI or services gets an automated test; the manual checklist covers those.
`pwsh` isn't installed on this Linux machine, so these tests run only in CI (Windows PowerShell 5.1).

## 4. Docs
- **Env template:** the `SQL_PASSWORD=` comment becomes "leave empty: the installer creates the login and fills this
  in". The template block in the README and in `docs/windows-plan.md` is updated to match.
- **README install section:**
  - the 11 steps;
  - the new option `-SkipSqlSetup`;
  - the restart prompt, explained;
  - the "first check usually fails" paragraph is removed (F3 plus the installer fix those cases).
- **README "SQL Server preparation":** what the installer does automatically, plus the manual path for technicians
  who aren't sysadmin (`sql-prepare.sql` and `-SkipSqlSetup`). `SQL_BACKUP_DIR` lookup stays manual.
- **README traps table:** a new "Fixed by installer" column (yes / after RESTART / no), plus a new row for the
  verify permission.
- **README Internals:** file map (`sql-prepare.sql`), new invariant, testing table.

## 5. Stages (each one commit, `npm test` green with Node 22)
1. `fix:` F1 + F2 + F3 + F7 in Node, `check --skip-sql` + `requireSql`, `sql-prepare.sql`, build-package, `.nvmrc`,
   tests, this plan.
2. `feat(installer):` the "Preparing SQL Server" step, `-SkipSqlSetup`, `-RestoreOnly` using `--skip-sql`,
   `test/install-functions.ps1` + CI step.
3. `docs:` README, RESTORE.md, env template, `docs/windows-plan.md` step list, this plan's status set to
   "implemented".

Nothing is pushed, tagged or released.

## 6. Version bump (for you, after testing)
`package.json` `"version": "0.1.1"` and the two `version` fields at the top of `package-lock.json`
(`npm version 0.1.1 --no-git-tag-version` does both), then tag `v0.1.1`. No other file contains the version: the zip
name and `install.ps1` take it from the tag.

## 7. Assumptions (to confirm with your lead)
- The technician running the installer is normally SQL `sysadmin` on client machines, because MerSoft installed SQL
  Server. If not, the manual script path applies.
- A ~30 s SQL Server restart during install is acceptable **only after explicit confirmation**. The default is to stop.
- When `SQL_PASSWORD` is empty and a login with that name already exists, it's ours from an earlier attempt, so the
  installer resets its password.
- Out of scope, and I won't touch these:
  - `uninstall.ps1 -Purge` doesn't drop the SQL login or users;
  - `SQL_BACKUP_DIR` isn't auto-detected, though the admin connection could read it;
  - possible follow-ups are noted only.

## 8. Manual test checklist (your Windows machine)
Before each run, note `Get-Service MSSQL*, SQLBrowser` and the env file.

- **(a) Fresh setup:** SQL Server Express named instance `SQLEXPRESS` with defaults (TCP off, Windows-only auth,
  Browser stopped/disabled). Two test DBs, `Sales` and `HR`. In the env file: `SQL_INSTANCE=SQLEXPRESS`,
  `SQL_PASSWORD` empty, the right `SQL_BACKUP_DIR`.
- **(b) Answer Enter at the prompt.** Expected:
  - the step lists "enable mixed mode, enable TCP/IP" and stops with "nothing was changed";
  - Configuration Manager still shows TCP disabled, and Server Properties still shows Windows-only auth;
  - SQL Server uptime hasn't changed (`SELECT sqlserver_start_time FROM sys.dm_os_sys_info`);
  - SQL Browser is Automatic and Running;
  - login `backup_user` exists with users in master/Sales/HR, and `SQL_PASSWORD` is filled in.
- **(c) Re-run and type `RESTART`.** Expected:
  - the service restarts (new `sqlserver_start_time`) and dependents that were running are running again;
  - `check` passes with no manual edits;
  - the Google sign-in works, the task is registered, and the first backup succeeds (verify included).
- **(d) Re-run again.** Expected:
  - no restart prompt; the summary says "kept" everywhere and "no settings changed";
  - `SQL_PASSWORD` is unchanged (compare the env file before and after).
- **(e) Non-sysadmin.** Run as a local admin that isn't in SQL `sysadmin` (or temporarily remove your login from the
  role). Expected: a clean stop that names the login used and the path `C:\Program Files\backup-manager\sql-prepare.sql`,
  with nothing changed.
  Also: `-SkipSqlSetup` only prints the path and goes on to `check`.
- **(f) Manual password.** On an existing install whose `SQL_PASSWORD` was set by hand, the password stays as it
  was: the env file is unchanged and the old password still logs in via SSMS. Grants are ensured, and
  `CHECK_EXPIRATION` is OFF (`SELECT is_expiration_checked FROM sys.sql_logins`).
- **(g) Extra checks:**
  - **Default instance** (`MSSQLSERVER`, your 2025 box): IPAll already has 1433, so no port change.
  - **Typo in `SQL_DATABASES`:** stops before any login is created.
  - **`-RestoreOnly`** with the template's SQL_* values and `SQL_PASSWORD` empty: step 7 says skipped, both checks
    pass with SQL rows `--`, there's no task and no backup, and `list` / `download latest --db X` work.
  - **Node:** with `SQL_TRUST_SERVER_CERTIFICATE` removed from the env file, `check` passes on localhost. With it
    set to `false`, the cert failure shows the neutral text.

## 9. Decisions (2026-11-18)
1. Base: `main` created on GitHub at 28267a9; PR `feat/sql-setup` into `main`.
2. `-RestoreOnly`: no SQL preparation; new `check --skip-sql`; RESTORE.md updated.
3. Default instance with another static port: keep it, write `SQL_PORT`.
4. `SQL_PASSWORD` set but the login is missing: stop and tell the technician to empty it and run again.
5. `-AllowSqlRestart`: not added (a possible later addition).
6. PowerShell tests: a plain PS 5.1 script in the Windows CI job, functions loaded via the AST.
7. `.nvmrc` with `22`.
