# Backup Manager: install on a client's server

## How it works

Backup Manager is a small program installed on the client's server. Every day at a set time (`BACKUP_TIME`) Windows Task Scheduler
starts it.
It:

1. tells SQL Server to make a full backup (`.bak`) of each database, into SQL Server's backup folder;
2. compresses and **encrypts** the `.bak` with the client's key;
3. uploads it to the **client's own Google Drive** (folder **MSSQL Backups**) and deletes the local copy;
4. deletes old backups on Drive (keeps the newest 7 + everything from the last 30 days).

The installer sets all of this up in one go. Backups can only be restored with the encryption key. **The client
keeps the key, not us.**

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

**3. From the client**
- Their **Gmail** address, and either the password or the client next to you to sign in.
- OK for a **~30-second SQL Server restart** (may be needed once, during install).
- A **flash drive** or another place outside this server (their PC, their password manager) to keep the
  encryption key.

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
SQL_BACKUP_DIR=C:\Program Files\Microsoft SQL Server\MSSQL16.MERSOFT11\MSSQL\Backup
```

| Field | Why |
|-------|-----|
| `SQL_DATABASES` | Which databases get backed up. Several: `EXAMPLE,EXAMPLE2`. |
| `SQL_INSTANCE` | Which SQL Server on this machine. Leave empty for the default instance. |
| `GOOGLE_EMAIL` | Whose Drive the backups go to. Sign-in with another account is refused. |
| `SQL_BACKUP_DIR` | Where SQL Server writes the `.bak` before upload. If you leave it empty, the installer asks SQL Server. |

**Leave empty:**
- `SQL_USER` / `SQL_PASSWORD`: the installer creates SQL login `backup_user` (backup rights only, random password)
  and writes it here. The daily task uses this login. Fill in only if the client's IT gave you a login.
- `BACKUP_ENCRYPTION_KEY`: generated in the next step.

**`BACKUP_TIME`: when the daily backup starts** (24 h format). **Ask the client: does this server run 24/7, or is
it turned off at night?**
- server runs **24/7** → leave `BACKUP_TIME=02:00` (nobody works at night);
- server is **turned off at night** → `BACKUP_TIME=13:30` (lunch time, the server is on and quieter).

**Leave as is:** `KEEP_LAST=7`, `KEEP_DAYS=30` (retention on Drive),
`SQL_HOST=localhost`, `SQL_PORT=1433`, `SQL_LOCAL_BACKUP_DIR` and `SERVER_NAME` (empty = computer name as Drive
folder).

**Ctrl+S**, close Notepad, back in PowerShell press **Enter**.

## Step 4: Give the encryption key to the client

**5/11**: a yellow box shows the key. **It's shown only once** and is already in the clipboard.

1. Paste it (**Ctrl+V**) into a text file **on the client's flash drive**, or let the client copy it somewhere
   safe that is **not this server** (their PC, their password manager, a printed copy).
2. Compare it with the screen.
3. Type `SAVED`, press **Enter**.

Tell the client: every backup is encrypted with this key. **We don't keep it.** If they lose it and the server dies,
the backups can't be restored. Don't save it on this server only: if the server is lost, the key is lost with it.

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

**Browser didn't open?** PowerShell prints a long link. Select it with the mouse, press **Enter** to copy, paste it
into a browser on the server by hand, sign in with the client's Gmail and allow access to Google Drive. PowerShell
continues by itself.

Then the installer checks it's the right account.

## Step 7: Task and first backup

**10/11**: creates the daily task **"PunkDuck Backup Manager"** in Task Scheduler (runs as SYSTEM at `BACKUP_TIME`).

**11/11**: runs the first backup. Up to an hour on big databases. Don't close the window.

Done when it says in green:

```
backup-manager is installed and the first backup succeeded.
```

Check: the client's Drive has **MSSQL Backups** with the backup inside.

**Red `INSTALL STOPPED`?** It says what's wrong. Fix it (settings:
`notepad C:\ProgramData\backup-manager\backup-manager.env`) and paste the command from Step 1 again. Rerunning is
always safe: it keeps what's done.

## Backups by hand

Daily backups are automatic. To back up now (e.g. before a software update), PowerShell as Administrator:

```powershell
$bm = "C:\Program Files\backup-manager\backup-manager.cmd"
& $bm backup               # all databases now
& $bm backup --db EXAMPLE  # one database
& $bm list                 # backups on Google Drive
& $bm check                # checks settings, SQL, Google; all lines should say OK
```

Backup failed: `& $bm check`, read the log in `C:\ProgramData\backup-manager\logs\`, fix, `& $bm backup`.

Several clients on one server and other special cases: [INSTALL.md](INSTALL.md).

## Restore

Restores are done **by us**, never by the client. There is no restore command: you download the backup (the program
decrypts and decompresses it into a normal `.bak`), then restore it in SSMS.

**Before you start**
- RDP to the client's server, PowerShell as Administrator.
- **The encryption key.** On the client's server it's already in the settings file. If you restore on another
  machine, get it **from the client** (their flash drive). No key = no restore.
- **Free disk space** for the full database size (the `.bak` is not compressed).
- **Agree with the client** what to restore. Default: restore next to the live database under a new name
  (`EXAMPLE_restored`) and let them check it. Overwrite the live database only if they explicitly ask.

**1. Find the backup**

```powershell
$bm = "C:\Program Files\backup-manager\backup-manager.cmd"
& $bm auth status            # must show the client's Gmail
& $bm list --db EXAMPLE      # newest first: date, server/db, file name, size, id
```

**2. Download and decrypt**

```powershell
New-Item -ItemType Directory -Force D:\restore | Out-Null
& $bm download latest --db EXAMPLE --out D:\restore     # newest backup
& $bm download <id> --out D:\restore                     # or a specific one, id from "list"
```

You get `D:\restore\EXAMPLE_YYYYMMDDTHHMMSSZ.bak` (time in UTC). SQL Server must be able to read it: put it in the
SQL backup folder (`SQL_BACKUP_DIR`) or give the SQL Server service account read access to `D:\restore`.

**3. Check the file** (SSMS, new query)

```sql
RESTORE VERIFYONLY FROM DISK = N'D:\restore\EXAMPLE_20261116T010000Z.bak' WITH CHECKSUM;
RESTORE FILELISTONLY FROM DISK = N'D:\restore\EXAMPLE_20261116T010000Z.bak';  -- logical names for MOVE below
```

**4a. Restore under a new name** (default)

```sql
RESTORE DATABASE EXAMPLE_restored
FROM DISK = N'D:\restore\EXAMPLE_20261116T010000Z.bak'
WITH MOVE N'EXAMPLE'     TO N'C:\Program Files\Microsoft SQL Server\MSSQL16.MERSOFT11\MSSQL\DATA\EXAMPLE_restored.mdf',
     MOVE N'EXAMPLE_log' TO N'C:\Program Files\Microsoft SQL Server\MSSQL16.MERSOFT11\MSSQL\DATA\EXAMPLE_restored_log.ldf',
     CHECKSUM, STATS = 10;
```

Use the logical names from `FILELISTONLY` after `MOVE N'...'`.

**4b. Overwrite the live database** (only if the client asks)

1. Nobody works in the application; stop its services if needed.
2. Safety backup of the current state first: `& $bm backup --db EXAMPLE`.
3. Then:

```sql
ALTER DATABASE EXAMPLE SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
RESTORE DATABASE EXAMPLE
FROM DISK = N'D:\restore\EXAMPLE_20261116T010000Z.bak'
WITH REPLACE, CHECKSUM, STATS = 10;
ALTER DATABASE EXAMPLE SET MULTI_USER;
```

Everything written after that backup is gone.

**5. After the restore**
- Let the client check the data.
- Delete the `.bak` from `D:\restore` (it's **not encrypted**). Drop `EXAMPLE_restored` when the client is done.
- On another server, fix the orphaned user: `ALTER USER backup_user WITH LOGIN = backup_user;`

### Client's server is dead: restore on another machine

> **Careful:** a normal install here would back up *this* machine into the client's Drive and delete their old
> backups by retention. Always use `-RestoreOnly`.

1. On a Windows machine with SQL Server of the **same or newer version**, PowerShell as Administrator:

   ```powershell
   [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
   irm https://github.com/arsenhuman/PunkDuck-Anchor/releases/latest/download/install.ps1 -OutFile install.ps1
   powershell -ExecutionPolicy Bypass -File .\install.ps1 -RestoreOnly
   ```

   No daily task, no backup, SQL Server is not touched.
2. In the .env: `BACKUP_ENCRYPTION_KEY` = the key **from the client's flash drive**, `GOOGLE_EMAIL` = client's Gmail.
   Leave `SERVER_NAME` **empty** and the `SQL_*` lines as they are.
3. Sign in to Google with the client's Gmail. The installer must say **"Restore-only install"**.
4. `& $bm list` shows the old server's name in the `server/db` column. Use it in steps 1-2 with `--server`:

   ```powershell
   & $bm list --server CLIENT-PC --db EXAMPLE
   & $bm download latest --server CLIENT-PC --db EXAMPLE --out D:\restore
   ```

   Then steps 3-5 as above.
5. When done: `powershell -ExecutionPolicy Bypass -File "C:\Program Files\backup-manager\uninstall.ps1" -Purge`
   (removes the key and Google sign-in from this machine; backups on Drive stay).

### Restore errors

| Message | What to do |
|---------|------------|
| `not logged in to Google` / `invalid_grant` | `& $bm auth login` |
| `no backups found for database "X"` | Wrong name (case-sensitive), wrong Google account, or wrong `--server`. Run `& $bm list` without filters. |
| `downloaded file checksum mismatch` | Download damaged. Run it again. |
| `decryption failed: wrong key or corrupted file` | Wrong `BACKUP_ENCRYPTION_KEY`. Get the right one from the client. |
| `... already exists (use --force to overwrite)` | That `.bak` is already in the folder. Delete it or add `--force`. |
| SQL error 3241 / "media family is incorrectly formed" | The `.bak` is from a newer SQL Server than the one you restore to. |
