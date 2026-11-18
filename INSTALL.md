# Installing Backup Manager on a client's server

A step-by-step guide for our technicians. Follow it from top to bottom. It takes about **20 minutes**.

**Works on:** Windows 10/11 and Windows Server 2016, 2019, 2022, 2025 (64-bit), with SQL Server 2016 or newer,
including Express.

When you are done, the client's SQL Server databases are backed up **every night** to the **client's own Google
Drive**, encrypted, and we get an alert if backups stop.

> Something went wrong? Read the red message: it says what to fix. Fix it and **run the installer again**. Running it
> again is always safe: it keeps everything you already did.

---

## 1. Before you start: get these ready

| # | What | Where to get it |
|---|------|-----------------|
| 1 | **RDP access** to the client's server, with a Windows account that is **Administrator**, plus either that account being **SQL Server sysadmin** (usually the account that installed SQL Server) **or the `sa` password** (Mersoft installs usually have one) | the client / our records |
| 2 | **The names of the databases** to back up | ask the client, or look in SSMS (see step 3) |
| 3 | **The client's Gmail address**, and either its password or the client next to you to sign in | the client |
| 4 | **A Healthchecks.io ping URL** for this client | create it, see below |
| 5 | **The company password manager** open, to save the encryption key | — |
| 6 | **OK from the client for a 30-second SQL Server restart**, in case the installer needs one | the client |

**Create the Healthchecks.io check** (once per client):

1. Log in to Healthchecks.io and click **Add Check**. Name it after the client.
2. Set **Period = 1 day** and **Grace Time = 4 days**.
3. Copy the **ping URL** (looks like `https://hc-ping.com/1234abcd-...`). Keep it for step 4.

---

## 2. Open PowerShell as Administrator

On the client's server:

1. Click **Start** and type `powershell`.
2. Right-click **Windows PowerShell**, then **Run as administrator**, then **Yes**.

> **Don't click inside the PowerShell window while the installer runs.** A click selects text and pauses the
> installer. If the window title starts with **"Select"**, press **Esc** to continue.

---

## 3. Find the database and instance names (if you don't know them)

Open **SQL Server Management Studio (SSMS)** and connect. In the left panel:

- The top line shows the server, e.g. `SERVER01` or `SERVER01\SQLEXPRESS`. The part after `\` is the
  **instance name** (here `SQLEXPRESS`). No `\` means the **default instance**.
- Open **Databases**. The names under it (not *System Databases*) are the **database names**.

---

## 4. Run the installer

Copy **both lines**, paste them into PowerShell (right-click pastes) and press **Enter**:

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
irm https://github.com/arsenhuman/PunkDuck-Anchor/releases/latest/download/install.ps1 | iex
```

The first line lets older Windows Server versions connect to GitHub securely. It is harmless everywhere else.

The installer works through **11 steps**. It stops and asks you only at these points:

### Step 4/11: the settings file opens in Notepad

Fill in these lines, nothing else:

| Line | What to write | Example |
|------|---------------|---------|
| `SQL_DATABASES=` | the database names, separated by commas | `SQL_DATABASES=Sales,Stock` |
| `SQL_INSTANCE=` | only for a named instance; leave empty for the default one. PowerShell lists the instances it found | `SQL_INSTANCE=SQLEXPRESS` |
| `GOOGLE_EMAIL=` | the client's Gmail | `GOOGLE_EMAIL=client@gmail.com` |
| `HEALTHCHECK_URL=` | the ping URL from section 1 | `HEALTHCHECK_URL=https://hc-ping.com/...` |

**`SQL_USER` and `SQL_PASSWORD`:**
- **Normally leave both empty.** The installer creates a SQL login called `backup_user` with a random password.
- Only if the client gives you a SQL login to use, enter its name and password there.

Leave everything else as it is. Then **save (Ctrl+S)**, **close Notepad**, go back to PowerShell and press **Enter**.

### Step 5/11: the encryption key

A yellow box shows a long key. **This is the only time you see it.**

1. The key is already **copied to the clipboard**.
2. Paste it (**Ctrl+V**) into the **company password manager** under this client, named "Backup encryption key".
   Check that the pasted key matches the one on screen.
3. In PowerShell type `SAVED` and press **Enter**.

> **Without this key, the client's backups can never be restored.** Don't skip this.

### Step 7/11: maybe a SQL Server restart

If SQL Server needs a setting changed, the installer lists what it will change and asks:

```
Type RESTART to apply now, or press Enter to stop and run the installer again later
```

- If the client agreed to the restart: type `RESTART` and press **Enter**. Everyone using the database is
  disconnected for about 30 seconds.
- If not now: press **Enter**. Nothing is changed. Run the installer again later, when a restart is OK.

If your Windows account can't sign in to SQL Server or isn't a sysadmin, the installer asks for a SQL Server
sysadmin login instead:

```
SQL Server sysadmin login (Enter for sa, or type SKIP to stop)
```

Press **Enter** for `sa` and type its password. It's used only for this step and isn't saved. You get 3 tries. If
you don't have a sysadmin password, type `SKIP` and see section 7.

### Step 9/11: Google sign-in

A browser window opens with the Google sign-in page.

> On **Windows Server** the browser often blocks Google ("Internet Explorer Enhanced Security") or no browser opens.
> Then use the "No browser window opened?" way below. It always works.

1. Sign in with the **client's** Gmail (the one in `GOOGLE_EMAIL`).
2. Google may warn that the app is unverified or ask for permissions: click **Continue** / **Allow**.
3. When the browser says the sign-in is complete, go back to PowerShell. It continues by itself.

**No browser window opened?** PowerShell shows a long link. Open it on **your own laptop**, sign in with the
client's account and allow access. The page then fails to load ("This site can't be reached"); **that is expected**.
Copy the whole address from the browser's address bar, paste it into PowerShell with **Ctrl+V** and press
**Enter**.

### Step 11/11: the first backup

The installer runs the first backup. This can take from a minute to an hour, depending on the database size.
Don't close the window.

---

## 5. Done: check the result

At the end you should see in green:

```
backup-manager is installed and the first backup succeeded.
```

Then check:

- [ ] On **Healthchecks.io**, the client's check is green ("up").
- [ ] The **encryption key** is in the password manager.
- [ ] Optional: in the client's Google Drive there is a folder **MSSQL Backups** with the backup inside.

From now on, the backup runs **every night at 02:00** automatically.

---

## 6. When something goes wrong

The installer prints **INSTALL STOPPED:** in red with the reason. Fix it and run the same command again.

| Message says | What to do |
|--------------|------------|
| `Database 'X' ... does not exist` | A database name is wrong. It lists the real names. Fix `SQL_DATABASES` in the settings file* |
| `SQL Server service ... not found` | Wrong `SQL_INSTANCE`. It lists the instances on the machine. Fix it in the settings file* |
| `The SQL login 'X' already exists, but SQL_PASSWORD is empty` | Enter that login's password in `SQL_PASSWORD`, **or** empty `SQL_USER` so the installer creates its own login |
| `SQL Server refused the login` | `SQL_USER` / `SQL_PASSWORD` are wrong. Fix them, or empty both |
| `Could not sign in as sa` | Wrong password, `sa` disabled, or SQL Server accepts only Windows sign-in. See section 7 |
| `... is not a sysadmin` | See section 7 |
| `The Google check failed` / wrong account | You signed in with the wrong Google account. Run the two `auth` commands below, then the installer again |
| `A backup is running right now` | Wait until it finishes, then run the installer again |
| The window looks frozen | Window title starts with "Select"? Press **Esc** |
| `Could not create SSL/TLS secure channel` | You ran only the second line of the command. Run both lines |
| `Only Windows 10/11 and Windows Server 2016 or newer` | This Windows is too old (e.g. Server 2012 R2). It can't be installed here; tell the team |

\* **The settings file** is `C:\ProgramData\backup-manager\backup-manager.env`. Open it with:

```powershell
notepad C:\ProgramData\backup-manager\backup-manager.env
```

**Wrong Google account:**

```powershell
& "C:\Program Files\backup-manager\backup-manager.cmd" auth logout
& "C:\Program Files\backup-manager\backup-manager.cmd" auth login
```

Still stuck? Send the red message and the log from `C:\ProgramData\backup-manager\logs\` to the team.

---

## 7. Special cases

**You are not a SQL Server sysadmin** (the client's IT manages SQL Server):

1. Give the client's DBA the file `C:\Program Files\backup-manager\sql-prepare.sql`. They run it in SSMS. The file
   explains what to replace.
2. The DBA gives you the password they set. Put `SQL_USER` and `SQL_PASSWORD` in the settings file.
3. Run the installer with the SQL step skipped:

   ```powershell
   [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
   irm https://github.com/arsenhuman/PunkDuck-Anchor/releases/latest/download/install.ps1 -OutFile install.ps1
   powershell -ExecutionPolicy Bypass -File .\install.ps1 -SkipSqlSetup
   ```

**No internet access to GitHub on the server:** download `backup-manager-<version>-win-x64.zip` **and** the matching
`.sha256` file from the GitHub release page, copy both into the same folder on the server, then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -ZipPath .\backup-manager-1.2.0-win-x64.zip
```

**Update to a new version:** run the same command from section 4 again. Settings, the key and the Google sign-in
are kept.

**Restoring a backup:** see [RESTORE.md](RESTORE.md).

**Uninstall:**

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Program Files\backup-manager\uninstall.ps1"
```

Backups already on Google Drive are never deleted.

---

## 8. Useful commands

```powershell
$bm = "C:\Program Files\backup-manager\backup-manager.cmd"
& $bm check          # checks everything; all lines should say OK
& $bm backup         # run a backup now
& $bm list           # list the backups on Google Drive
& $bm auth status    # which Google account is connected
```

To see why a night's backup failed: open **Task Scheduler**, then **"PunkDuck Backup Manager"**, then **Last Run
Result**, and the log of that day in `C:\ProgramData\backup-manager\logs\`.

For technical details see [README.md](README.md).
