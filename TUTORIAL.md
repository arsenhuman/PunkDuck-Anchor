# Backup Manager: install on a client's server

**Have ready:** RDP admin access, the client's Gmail (+ password), a Healthchecks.io ping URL for the client
(Period 1 day, Grace 4 days), the password manager, the client's OK for a 30-second SQL Server restart.

Log in to Windows with the account that opens **SSMS with Windows Authentication**. The installer uses it to set up
SQL Server. If it can't, have the `sa` password ready.

## Before you paste: look up 3 things in SSMS

In SSMS, connected to the server:

- **Instance name:** the top line in Object Explorer, e.g. `SERVER01\MERSOFT11`. The part after `\` is the
  instance: `MERSOFT11`. No `\` = default instance.
- **Database names:** under **Databases** (not System Databases), e.g. `EXAMPLE`.
- **Backup folder:** right-click the server (top line) → **Properties** → **Database Settings** → under
  *Database default locations*, copy **Backup**. Usually
  `C:\Program Files\Microsoft SQL Server\MSSQL16.MERSOFT11\MSSQL\Backup`.
  Or run in a new query: `SELECT SERVERPROPERTY('InstanceDefaultBackupPath');`

## Run the installer

Open **PowerShell as Administrator** and paste:

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
irm https://github.com/arsenhuman/PunkDuck-Anchor/releases/latest/download/install.ps1 | iex
```

Don't click inside the window while it runs (title starts with "Select" → press **Esc**).
If it stops with red **INSTALL STOPPED**, fix what it says and paste the command again. Rerunning is always safe.

## What happens in each step

| Step | What the installer does | What you do |
|------|-------------------------|-------------|
| **1/11** Prerequisites | Checks Windows version, 64-bit, admin rights. | Nothing. |
| **2/11** Package | Downloads the latest release from GitHub and verifies its checksum. | Nothing. |
| **3/11** Program files | Installs to `C:\Program Files\backup-manager`. | Nothing. |
| **4/11** Settings | Creates `C:\ProgramData\backup-manager\backup-manager.env`, opens it in Notepad, lists the SQL instances found. | **Fill in the .env** (see below), save, close Notepad, press **Enter**. |
| **5/11** Encryption key | Generates the key that encrypts every backup and shows it **once** (already copied to clipboard). | Paste it into the password manager under the client as "Backup encryption key", type `SAVED`. **No key = no restore.** |
| **6/11** Folder access | Locks the program and settings folders to SYSTEM and Administrators. | Nothing. |
| **7/11** SQL Server | Signs in with your Windows account. Checks the databases exist. Creates SQL login `backup_user` (backup rights only) and writes its password into the .env. Enables mixed authentication mode and TCP/IP if they're off. | If asked, type `RESTART` (~30 s downtime) or Enter to stop and rerun later. If your Windows account isn't sysadmin: Enter for `sa`, type its password (not saved). |
| **8/11** Check | Tests the settings, the SQL connection with `backup_user` and the backup folder. | Nothing. |
| **9/11** Google | Opens the Google sign-in in a browser. Then checks it's the account from `GOOGLE_EMAIL`. | Sign in with the **client's** Gmail, click Continue/Allow. No browser? Open the printed link on your laptop, sign in, copy the full URL of the "can't be reached" page and paste it into PowerShell. |
| **10/11** Task | Creates the nightly task "PunkDuck Backup Manager" in Task Scheduler (runs as SYSTEM). | Nothing. |
| **11/11** First backup | Backs up, compresses, encrypts and uploads to the client's Drive (folder **MSSQL Backups**). | Wait, don't close the window. Can take up to an hour. |

Done when it says in green: `backup-manager is installed and the first backup succeeded.` Then check that the
Healthchecks.io check is green.

## The .env file: what each field is for

Write the value right after `=`, no spaces, no quotes. Reopen later with
`notepad C:\ProgramData\backup-manager\backup-manager.env`.

**You fill in:**

| Field | What it's for | Example |
|-------|---------------|---------|
| `SQL_DATABASES` | Which databases get backed up. Comma-separated, exact SSMS names. | `SQL_DATABASES=EXAMPLE` |
| `SQL_INSTANCE` | Which SQL Server instance on this machine. Empty = default instance. | `SQL_INSTANCE=MERSOFT11` |
| `SQL_BACKUP_DIR` | Folder where SQL Server writes the `.bak` before it's encrypted and uploaded. Paste the backup folder from SSMS. (If empty, the installer asks SQL Server for it.) | `SQL_BACKUP_DIR=C:\Program Files\Microsoft SQL Server\MSSQL16.MERSOFT11\MSSQL\Backup` |
| `GOOGLE_EMAIL` | Client's Google account. Backups go to its Drive. The installer refuses another account at sign-in. | `GOOGLE_EMAIL=client@gmail.com` |
| `HEALTHCHECK_URL` | Pinged after every backup. If pings stop, Healthchecks.io alerts us. | `HEALTHCHECK_URL=https://hc-ping.com/1234abcd-...` |

**Leave empty, the installer fills them in:**

| Field | What it's for |
|-------|---------------|
| `SQL_USER` / `SQL_PASSWORD` | SQL login the nightly backup uses. Installer creates `backup_user` with a random password. Fill in only if the client's IT gave you a login. |
| `BACKUP_ENCRYPTION_KEY` | The key from step 5. **Never change it.** |

**Defaults, change only if needed:**

| Field | What it's for | Default |
|-------|---------------|---------|
| `BACKUP_TIME` | Nightly start time (24 h). | `02:00` |
| `KEEP_LAST` | Always keep at least this many newest backups on Drive. | `7` |
| `KEEP_DAYS` | Also keep every backup younger than this. Older ones are deleted. | `30` |
| `SQL_HOST` | Machine with SQL Server. `localhost` = this one. | `localhost` |
| `SQL_PORT` | SQL Server TCP port. | `1433` |
| `SQL_LOCAL_BACKUP_DIR` | Only when SQL Server is on another machine: the backup folder as a network share. | empty |
| `SERVER_NAME` | Folder name on Google Drive. Empty = computer name. | empty |

## Backups

They run automatically every night at `BACKUP_TIME`. To back up by hand (e.g. before a software update), in
PowerShell as Administrator:

```powershell
$bm = "C:\Program Files\backup-manager\backup-manager.cmd"
& $bm backup               # all databases now
& $bm backup --db EXAMPLE  # one database
& $bm list                 # backups on Google Drive
& $bm check                # checks settings, SQL, Google; all lines should say OK
```

Failed night: `& $bm check`, read the log in `C:\ProgramData\backup-manager\logs\`, fix, `& $bm backup`.

Restore: [RESTORE.md](RESTORE.md). Several clients on one server and other special cases: [INSTALL.md](INSTALL.md).
