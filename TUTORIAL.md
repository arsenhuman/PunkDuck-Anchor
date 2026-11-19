# Backup Manager: install

**1.** Open **PowerShell as Administrator** (log in to Windows with the account that opens SSMS via Windows Authentication). Paste:

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
irm https://github.com/arsenhuman/PunkDuck-Anchor/releases/latest/download/install.ps1 | iex
```

**2.** Notepad opens the `.env` file. Fill in:

```
SQL_DATABASES=Sales,Stock          # names from SSMS, comma-separated
SQL_INSTANCE=SQLEXPRESS            # part after "\" in SSMS server name; empty if none
GOOGLE_EMAIL=client@gmail.com
HEALTHCHECK_URL=https://hc-ping.com/...
```

Leave `SQL_USER` and `SQL_PASSWORD` **empty**. Save, close Notepad, press **Enter**.

**3.** Encryption key appears → save it in the password manager under the client → type `SAVED`.

**4.** If asked → type `RESTART` (SQL Server restarts ~30 s). If asked for a sysadmin login → Enter, then the `sa` password.

**5.** Sign in to Google with the **client's** Gmail. No browser? Open the printed link on your laptop, sign in, copy the
final URL back into PowerShell.

**6.** Wait for green `first backup succeeded`. Check Healthchecks.io is green.

Error? Fix what the red text says and run step 1 again.

## Backup manually

```powershell
$bm = "C:\Program Files\backup-manager\backup-manager.cmd"
& $bm backup              # all databases now
& $bm backup --db Sales   # one database
& $bm list                # backups on Drive
& $bm check               # everything OK?
```

Restore: [RESTORE.md](RESTORE.md). Special cases: [INSTALL.md](INSTALL.md).
