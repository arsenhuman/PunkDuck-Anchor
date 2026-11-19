# Backup Manager: install on a client's server

**Have ready:** RDP admin access, database names, client's Gmail (+ password or the client nearby), a
Healthchecks.io ping URL for the client (Period 1 day, Grace 4 days), the password manager, client's OK for a
30-second SQL Server restart.

Log in to Windows with the account that opens **SSMS with Windows Authentication**. The installer uses this account
to set SQL Server up, so no SQL password is needed. If that account can't open SSMS, have the `sa` password ready.

## 1. Run the installer

Open **PowerShell as Administrator** and paste:

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
irm https://github.com/arsenhuman/PunkDuck-Anchor/releases/latest/download/install.ps1 | iex
```

The installer downloads the program, checks it, installs it to `C:\Program Files\backup-manager`, creates the
settings folder `C:\ProgramData\backup-manager` and then opens the settings file. Don't click inside the window while
it runs (if the title starts with "Select", press **Esc**).

## 2. Fill in the .env file

Notepad opens `backup-manager.env`. PowerShell lists the SQL instances it found on this server.
Write each value right after `=`, no spaces, no quotes.

| Line | What to write |
|------|---------------|
| `SQL_DATABASES=` | Databases to back up, exactly as in SSMS, comma-separated. `SQL_DATABASES=Sales,Stock` |
| `SQL_INSTANCE=` | In SSMS the server name is e.g. `SERVER01\SQLEXPRESS`: write the part after `\` → `SQL_INSTANCE=SQLEXPRESS`. No `\` → leave empty. |
| `SQL_USER=` / `SQL_PASSWORD=` | **Leave empty.** The installer creates a login `backup_user` with a random password and writes it here. Fill in only if the client's IT gave you a specific SQL login. |
| `GOOGLE_EMAIL=` | Client's Gmail. Backups go to their Google Drive. |
| `HEALTHCHECK_URL=` | The Healthchecks.io ping URL. We get an alert if backups stop. |
| `BACKUP_TIME=` | Nightly start time, default `02:00`. Change only if needed. |
| `KEEP_LAST=` / `KEEP_DAYS=` | Retention: keeps the newest 7 and everything from the last 30 days. Leave as is. |

Everything else: don't touch, the installer fills it. Save (**Ctrl+S**), close Notepad, press **Enter** in PowerShell.

## 3. Follow the prompts

- **Encryption key** (yellow box, shown only once): it's already in the clipboard. Paste it into the password
  manager under the client as "Backup encryption key", then type `SAVED`. Without it backups can't be restored.
- **SQL Server setup:** the installer signs in with your Windows account and creates the `backup_user` login with
  backup rights on the databases. If SQL Server needs changes (mixed authentication mode, TCP/IP), it lists them and
  asks for `RESTART`: type it (users disconnected ~30 s) or press Enter to stop and rerun later.
  If your Windows account isn't a SQL admin it asks for a login: press Enter for `sa` and type its password (not saved).
- **Google sign-in:** a browser opens. Sign in with the **client's** Gmail and click Continue/Allow.
  No browser or it's blocked (common on Windows Server): open the printed link on your laptop, sign in, copy the
  full URL of the "can't be reached" page and paste it into PowerShell.
- **Nightly task + first backup:** the installer creates the scheduled task "PunkDuck Backup Manager" and runs the
  first backup. Can take up to an hour on big databases. Don't close the window.

## 4. Check

- Green message: `backup-manager is installed and the first backup succeeded.`
- Healthchecks.io check is green.
- Client's Google Drive has a folder **MSSQL Backups**.

Error: the red **INSTALL STOPPED** line says what's wrong. Fix it (settings file:
`notepad C:\ProgramData\backup-manager\backup-manager.env`) and paste the command from step 1 again. Rerunning is safe.

## Backups

They run automatically every night at `BACKUP_TIME`: compressed, encrypted, uploaded to the client's Drive, old ones
cleaned up. To back up by hand (e.g. before a software update), in PowerShell as Administrator:

```powershell
$bm = "C:\Program Files\backup-manager\backup-manager.cmd"
& $bm backup              # all databases now
& $bm backup --db Sales   # one database
& $bm list                # backups on Google Drive
& $bm check               # checks SQL, Google, settings; all lines should say OK
```

Failed night: run `& $bm check`, see the log in `C:\ProgramData\backup-manager\logs\`, fix, run `& $bm backup`.

Restore: [RESTORE.md](RESTORE.md). Several clients on one server, other special cases: [INSTALL.md](INSTALL.md).
