# Backup Manager: step-by-step tutorial for technicians

This is the short, practical guide for installing Backup Manager on a client's server and taking backups.
Follow it from top to bottom. It takes about **20 minutes**.

For special cases (several clients on one server, SQL Server on another machine, no internet) see
[INSTALL.md](INSTALL.md). To restore a backup see [RESTORE.md](RESTORE.md).

---

## 0. What you need before you start

- [ ] **Remote Desktop (RDP) access** to the client's server, with a Windows account that is **Administrator**.
- [ ] **The names of the databases** to back up (step 2 shows how to find them).
- [ ] **The client's Gmail address**, and its password (or the client next to you to sign in).
- [ ] **A Healthchecks.io ping URL** for this client (see below).
- [ ] **The company password manager** open, to save the encryption key.
- [ ] **OK from the client for a 30-second SQL Server restart** (only needed the first time, see step 5).

**Create the Healthchecks.io check** (once per client):

1. Log in to Healthchecks.io and click **Add Check**. Name it after the client.
2. Set **Period = 1 day** and **Grace Time = 4 days**.
3. Copy the **ping URL**. It looks like `https://hc-ping.com/1234abcd-...`. You will paste it in step 4.

---

## 1. Check your SQL Server access (Windows Authentication)

Almost every client server lets you into SQL Server with **Windows Authentication**: you log in to Windows, and
SQL Server trusts that Windows account. **No SQL username or password is needed.** This is the normal case and the
installer is built for it.

Check it in 10 seconds:

1. On the client's server, open **SQL Server Management Studio (SSMS)**.
2. In the **Connect to Server** window:
   - **Server name:** leave what is there (e.g. `SERVER01` or `SERVER01\SQLEXPRESS`).
   - **Authentication:** **Windows Authentication**.
3. Click **Connect**.

| Result | What it means |
|--------|---------------|
| It connects and you can open the **Databases** folder | You are ready. In step 4 you leave `SQL_USER` and `SQL_PASSWORD` **empty**. |
| It fails, or you can't see the databases | Your Windows account is not a SQL admin. Get the **`sa` password** from the client or our records; the installer will ask for it in step 5. |

> **Important:** run the installer while logged in to Windows with **the same account** you just used in SSMS. The
> installer uses that account to set SQL Server up.

**What the installer does with SQL Server** (so you are not surprised):

- It signs in to SQL Server with **your Windows account** (only during installation).
- It creates its own SQL login called **`backup_user`** with a random password, and writes it into the settings
  file. This login can only make backups, nothing else. The nightly backup uses it.
- For that login to work, SQL Server must allow "SQL Server and Windows Authentication mode". If this is switched
  off, the installer turns it on and asks you for a **short SQL Server restart** (step 5). Windows Authentication
  keeps working exactly as before.

You don't have to do any of this by hand.

---

## 2. Find the database names and the instance name

Still in SSMS, look at the left panel:

- **The top line** is the server, e.g. `SERVER01\SQLEXPRESS`.
  - The part **after the `\`** is the **instance name** (here `SQLEXPRESS`).
  - **No `\`** (just `SERVER01`) means the **default instance**: you leave the instance empty.
- Open **Databases**. The names there (**not** the ones under *System Databases*) are the **database names**.
  Write them down exactly as shown.

---

## 3. Open PowerShell as Administrator and paste the command

1. Click **Start**, type `powershell`.
2. Right-click **Windows PowerShell** → **Run as administrator** → **Yes**.
3. Copy **both lines** below, paste them into PowerShell (**right-click** pastes) and press **Enter**:

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
irm https://github.com/arsenhuman/PunkDuck-Anchor/releases/latest/download/install.ps1 | iex
```

The installer downloads the program from GitHub and goes through **11 steps**. It stops only when it needs you.

> **Don't click inside the PowerShell window while it runs.** If the window title starts with **"Select"**, the
> installer is paused: press **Esc** to continue.

---

## 4. Fill in the settings file (.env)

At **step 4/11** the settings file opens in **Notepad**. Fill in only these lines:

| Line | What to write | Example |
|------|---------------|---------|
| `SQL_DATABASES=` | the database names from step 2, separated by commas, no spaces | `SQL_DATABASES=Sales,Stock` |
| `SQL_INSTANCE=` | the instance name from step 2. **Leave empty** for the default instance. (PowerShell also lists the instances it found.) | `SQL_INSTANCE=SQLEXPRESS` |
| `SQL_USER=` | **leave empty** | `SQL_USER=` |
| `SQL_PASSWORD=` | **leave empty** | `SQL_PASSWORD=` |
| `GOOGLE_EMAIL=` | the client's Gmail | `GOOGLE_EMAIL=client@gmail.com` |
| `HEALTHCHECK_URL=` | the ping URL from step 0 | `HEALTHCHECK_URL=https://hc-ping.com/1234abcd-...` |

Rules:

- Write the value **right after `=`**, without spaces and without quotes.
- **Don't touch anything else.** The other lines are either fine as they are or filled in by the installer.
- Optional: `BACKUP_TIME=02:00` is when the nightly backup starts (24-hour time). Change it only if the client asks.

**Why `SQL_USER` and `SQL_PASSWORD` stay empty:** with Windows Authentication (step 1) the installer creates the
`backup_user` login itself and fills these two lines in for you. Only enter something here if the client's IT
gives you a specific SQL login to use.

When done: **Ctrl+S** to save, **close Notepad**, go back to PowerShell and press **Enter**.

---

## 5. Answer the installer's questions

### Step 5/11: the encryption key (do not skip!)

A yellow box shows a long key. **This is the only time it is shown.**

1. The key is already copied. Open the **company password manager**, create an entry for this client named
   **"Backup encryption key"** and paste it (**Ctrl+V**).
2. Check that what you pasted matches the key on screen.
3. In PowerShell type `SAVED` and press **Enter**.

> **Without this key the client's backups can never be restored.**

### Step 7/11: SQL Server setup (maybe a restart)

The installer signs in to SQL Server with your Windows account and prepares it.

- If it shows a list of changes and asks you to type `RESTART`:
  - Client agreed to the restart → type `RESTART` and press **Enter**. Users are disconnected for about 30 seconds.
  - Not now → press **Enter**. Nothing changes. Run the same command (step 3) again later.
- If it says your Windows account is not a sysadmin and asks
  `SQL Server sysadmin login (Enter for sa)`: press **Enter**, then type the **`sa` password**. It is used only
  now and is not saved.

### Step 9/11: Google sign-in

A browser opens with the Google sign-in page.

1. Sign in with the **client's** Gmail (the same as `GOOGLE_EMAIL`).
2. If Google warns the app is unverified, click **Continue** / **Allow**.
3. When the browser says sign-in is complete, go back to PowerShell. It continues by itself.

**No browser opened, or the browser is blocked** (common on Windows Server): PowerShell shows a long link.

1. Open that link on **your own laptop** and sign in with the client's account, allow access.
2. The page then shows "This site can't be reached". **That is expected.**
3. Copy the **whole address** from the address bar, paste it into PowerShell with **Ctrl+V**, press **Enter**.

### Step 11/11: the first backup

The installer makes the first backup right away. It can take from one minute to an hour depending on database
size. **Don't close the window.**

---

## 6. Check that it worked

At the end you should see in green:

```
backup-manager is installed and the first backup succeeded.
```

Then tick off:

- [ ] **Healthchecks.io**: the client's check is **green**.
- [ ] **Password manager**: the encryption key is saved under this client.
- [ ] **Client's Google Drive**: there is a folder **MSSQL Backups** with the backup in it.

From now on the backup runs **automatically every night** (at `BACKUP_TIME`, default 02:00). You don't need to do
anything else.

---

## 7. How to back up (and check backups)

Backups run by themselves every night. Use these commands when you want to **make a backup right now** (for example
before an update of the client's software) or to **check** that everything is fine.

Open **PowerShell as Administrator** (step 3) and first paste this line once:

```powershell
$bm = "C:\Program Files\backup-manager\backup-manager.cmd"
```

Then:

| What you want | Command |
|---------------|---------|
| **Back up all databases now** | `& $bm backup` |
| **Back up one database now** | `& $bm backup --db Sales` |
| **See the backups on Google Drive** (newest first) | `& $bm list` |
| **Check that everything works** (all lines should say OK) | `& $bm check` |
| **See which Google account is connected** | `& $bm auth status` |

A manual backup is uploaded to the client's Google Drive, the same as the nightly one. Old backups are cleaned up
automatically (by default the newest 7 are always kept, plus everything from the last 30 days).

**Did last night's backup fail?**

1. If Healthchecks.io sends an alert, connect to the server and run `& $bm check`. It tells you what is wrong.
2. Look at the log of that day in `C:\ProgramData\backup-manager\logs\`.
3. Fix it, then run `& $bm backup` to make a fresh backup straight away.

**Restoring** is done only by our team, never by the client: see [RESTORE.md](RESTORE.md).

---

## 8. If something goes wrong during install

The installer shows **INSTALL STOPPED:** in red with the reason. Fix it and **run the same command (step 3) again**.
Running it again is always safe: it keeps everything already done.

| The red message says | What to do |
|----------------------|------------|
| `Database 'X' ... does not exist` | A database name is misspelled. It lists the real names. Fix `SQL_DATABASES`.* |
| `SQL Server service ... not found` | Wrong `SQL_INSTANCE`. It lists the instances. Fix it.* |
| `Could not sign in as sa` | Wrong `sa` password, or `sa` is disabled. Get the correct password from the client. |
| `... is not a sysadmin` | Neither your Windows account nor the login you typed is a SQL admin. See INSTALL.md section 7. |
| `SQL Server refused the login` | Something was typed into `SQL_USER` / `SQL_PASSWORD`. Empty both lines.* |
| `Could not create SSL/TLS secure channel` | You pasted only the second line. Paste both lines. |
| Wrong Google account | Run `& $bm auth logout`, then `& $bm auth login`, then the installer again. |
| The window looks frozen | Title starts with "Select"? Press **Esc**. |

\* To reopen the settings file:

```powershell
notepad C:\ProgramData\backup-manager\backup-manager.env
```

Still stuck? Send the red message and the newest file from `C:\ProgramData\backup-manager\logs\` to the team.
