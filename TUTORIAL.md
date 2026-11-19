# Backup Manager: install on a client's server

## How it works

Backup Manager is a small program installed on the client's server. Every night Windows Task Scheduler starts it.
It:

1. tells SQL Server to make a full backup (`.bak`) of each database, into SQL Server's backup folder;
2. compresses and **encrypts** the `.bak` with the client's key;
3. uploads it to the **client's own Google Drive** (folder **MSSQL Backups**) and deletes the local copy;
4. deletes old backups on Drive (keeps the newest 7 + everything from the last 30 days);
5. pings **Healthchecks.io**. If the ping doesn't come, Healthchecks alerts us.

The installer sets all of this up in one go. Backups can only be restored with the encryption key, which lives in
our password manager.

## Before you start

**1. Get access**
- RDP to the client's server with a Windows account that is **Administrator**.
- That account should open **SSMS with Windows Authentication** (usually the account that installed SQL Server).
  The installer uses it to set up SQL Server. If it can't, get the **`sa` password** from our records.

**2. Look up 3 things in SSMS** (connect with Windows Authentication)
- **Instance name:** the top line in Object Explorer, e.g. `SERVER01\MERSOFT11` → the part after `\`:
  `MERSOFT11`. No `\` = default instance.
- **Database names:** expand **Databases** (ignore *System Databases*), e.g. `EXAMPLE`. Exact spelling.
- **Backup folder:** right-click the top line → **Properties** → **Database Settings** → *Database default
  locations* → copy **Backup**. Or new query: `SELECT SERVERPROPERTY('InstanceDefaultBackupPath');`
  Usually `C:\Program Files\Microsoft SQL Server\MSSQL16.MERSOFT11\MSSQL\Backup`.

**3. Create the Healthchecks.io check**
- Healthchecks.io → **Add Check** → name it after the client.
- **Period = 1 day**, **Grace Time = 4 days**.
- Copy the **ping URL** (`https://hc-ping.com/...`).

**4. From the client**
- Their **Gmail** address, and either the password or the client next to you to sign in.
- OK for a **~30-second SQL Server restart** (may be needed once, during install).

**5. Open the company password manager.** You'll save the encryption key there.

## Step 1: Paste the command

Start → type `powershell` → right-click **Windows PowerShell** → **Run as administrator** → Yes. Paste both lines
(right-click pastes) and press **Enter**:

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
irm https://github.com/arsenhuman/PunkDuck-Anchor/releases/latest/download/install.ps1 | iex
```

The first line enables TLS 1.2 (old Windows Servers need it to reach GitHub). The second downloads and runs the
installer.

Don't click inside the window while it runs. If the title starts with "Select", press **Esc**.

## Step 2: The installer starts working

It goes through 11 steps and prints each one. The first three need nothing from you:

- **1/11** checks Windows version, 64-bit, admin rights;
- **2/11** downloads the latest release from GitHub and verifies its checksum;
- **3/11** installs the program to `C:\Program Files\backup-manager`.

## Step 3: Notepad opens the .env file

**4/11**: the installer creates the settings file `C:\ProgramData\backup-manager\backup-manager.env` and opens it in
Notepad. PowerShell lists the SQL instances it found. Write each value right after `=`, no spaces, no quotes:

```
SQL_DATABASES=EXAMPLE
SQL_INSTANCE=MERSOFT11
GOOGLE_EMAIL=client@gmail.com
HEALTHCHECK_URL=https://hc-ping.com/1234abcd-...
SQL_BACKUP_DIR=C:\Program Files\Microsoft SQL Server\MSSQL16.MERSOFT11\MSSQL\Backup
```

| Field | Why |
|-------|-----|
| `SQL_DATABASES` | Which databases get backed up. Several: `EXAMPLE,EXAMPLE2`. |
| `SQL_INSTANCE` | Which SQL Server on this machine. Leave empty for the default instance. |
| `GOOGLE_EMAIL` | Whose Drive the backups go to. Sign-in with another account is refused. |
| `HEALTHCHECK_URL` | Where to ping after every backup, so we get alerted when backups stop. |
| `SQL_BACKUP_DIR` | Where SQL Server writes the `.bak` before upload. If you leave it empty, the installer asks SQL Server. |

**Leave empty:**
- `SQL_USER` / `SQL_PASSWORD`: the installer creates SQL login `backup_user` (backup rights only, random password)
  and writes it here. The nightly task uses this login. Fill in only if the client's IT gave you a login.
- `BACKUP_ENCRYPTION_KEY`: generated in the next step.

**Leave as is:** `BACKUP_TIME=02:00` (nightly start), `KEEP_LAST=7`, `KEEP_DAYS=30` (retention on Drive),
`SQL_HOST=localhost`, `SQL_PORT=1433`, `SQL_LOCAL_BACKUP_DIR` and `SERVER_NAME` (empty = computer name as Drive
folder).

**Ctrl+S**, close Notepad, back in PowerShell press **Enter**.

## Step 4: Save the encryption key

**5/11**: a yellow box shows the key. **It's shown only once** and is already in the clipboard.

1. Password manager → this client → new entry "Backup encryption key" → **Ctrl+V**.
2. Compare with the screen.
3. Type `SAVED`, press **Enter**.

Why: every backup is encrypted with this key. Lose it and the backups are useless.

**6/11**: the installer locks its folders to SYSTEM and Administrators. Nothing to do.

## Step 5: SQL Server setup

**7/11**: the installer signs in to SQL Server **with your Windows account**, checks the databases exist, reads the
backup folder, and creates the `backup_user` login with backup rights on your databases.

- If mixed authentication mode or TCP/IP is off, it lists the changes and asks for `RESTART`. Type it (users are
  disconnected ~30 s), or press Enter to stop and paste the command again later.
  Why: `backup_user` is a SQL login, so SQL Server must accept SQL logins too. Windows Authentication keeps working.
- If your Windows account isn't a SQL sysadmin, it asks `SQL Server sysadmin login (Enter for sa)`: press **Enter**,
  type the `sa` password. Used only now, not saved.

**8/11**: tests the settings, the SQL connection as `backup_user`, and the backup folder.

## Step 6: Google sign-in

**9/11**: why: the program needs permission to upload to the client's Drive. It can only see files it created itself,
nothing else in their Drive.

A browser opens with the Google sign-in:

1. Sign in with the **client's** Gmail (the one in `GOOGLE_EMAIL`).
2. "Google hasn't verified this app" → **Continue**. Permissions → **Allow** / **Continue**.
3. Browser says sign-in complete → back to PowerShell, it continues by itself.

**Browser didn't open, or Windows Server blocks Google** (common):

1. PowerShell prints a long link. Select it with the mouse and press **Enter** to copy.
2. Open it on **your own laptop**, sign in with the client's account, allow.
3. The page then shows **"This site can't be reached"**. That's expected.
4. Copy the **whole address** from the address bar, paste it into PowerShell (**Ctrl+V**), press **Enter**.

Then the installer checks it's the right account.

## Step 7: Task and first backup

**10/11**: creates the nightly task **"PunkDuck Backup Manager"** in Task Scheduler (runs as SYSTEM at `BACKUP_TIME`).

**11/11**: runs the first backup. Up to an hour on big databases. Don't close the window.

Done when it says in green:

```
backup-manager is installed and the first backup succeeded.
```

Check: Healthchecks.io is green, the client's Drive has **MSSQL Backups** with the backup inside.

**Red `INSTALL STOPPED`?** It says what's wrong. Fix it (settings:
`notepad C:\ProgramData\backup-manager\backup-manager.env`) and paste the command from Step 1 again. Rerunning is
always safe: it keeps what's done.

## Backups by hand

Nightly backups are automatic. To back up now (e.g. before a software update), PowerShell as Administrator:

```powershell
$bm = "C:\Program Files\backup-manager\backup-manager.cmd"
& $bm backup               # all databases now
& $bm backup --db EXAMPLE  # one database
& $bm list                 # backups on Google Drive
& $bm check                # checks settings, SQL, Google; all lines should say OK
```

Failed night: `& $bm check`, read the log in `C:\ProgramData\backup-manager\logs\`, fix, `& $bm backup`.

Restore: [RESTORE.md](RESTORE.md). Several clients on one server and other special cases: [INSTALL.md](INSTALL.md).
