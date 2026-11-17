# Restoring a backup (team runbook)

Restores are **always done by our team**, never by the client. There is no `restore` command: you download the
backup with `backup-manager download`, which decrypts and decompresses it into a plain `.bak` file, and then restore
it into SQL Server by hand.

## Before you start

- **RDP access** to the client machine (or another Windows machine with SQL Server; see *Restoring elsewhere*).
- **The client's encryption key** from the company password manager. On the client machine it is already in
  `C:\ProgramData\backup-manager\backup-manager.env`. **Without the key, the backup cannot be restored.**
- **Enough free disk space** for the full `.bak`. The download is compressed, but the restored `.bak` is the
  database's full size.
- **Agreement with the client** about *what* to restore and *where*. Default: restore next to the live database
  under a new name (e.g. `Sales_restored`) and let the client check it. Only overwrite the live database if the
  client explicitly asks for it.

## 1. Find the backup

In an **Administrator** PowerShell on the client machine:

```powershell
$bm = "C:\Program Files\backup-manager\backup-manager.cmd"
& $bm auth status          # must show the client's Google account
& $bm list --db Sales      # newest first: date, server/db, file name, size, id
```

## 2. Download and decrypt

```powershell
New-Item -ItemType Directory -Force D:\restore | Out-Null

# the newest backup of Sales
& $bm download latest --db Sales --out D:\restore

# or a specific one, by the id shown by "list"
& $bm download <fileId> --out D:\restore
```

`download` checks the SHA-256 of what Drive returned, decrypts and decompresses, and writes
`D:\restore\Sales_YYYYMMDDTHHMMSSZ.bak` (time in UTC). It refuses to overwrite an existing file unless you add `--force`.

SQL Server's service account must be able to read the file. Either put it in the SQL backup folder (`SQL_BACKUP_DIR`)
or grant the service account read access to `D:\restore`.

## 3. Check the backup file

In SSMS (or `sqlcmd -S localhost\SQLEXPRESS -E`), connected as an administrator:

```sql
RESTORE VERIFYONLY FROM DISK = N'D:\restore\Sales_20261116T010000Z.bak' WITH CHECKSUM;

-- logical file names and sizes; you need these for MOVE below
RESTORE FILELISTONLY FROM DISK = N'D:\restore\Sales_20261116T010000Z.bak';
```

## 4a. Restore under a new name (default)

Use the logical names from `FILELISTONLY` and new physical file names, so the live database's files are not touched:

```sql
RESTORE DATABASE Sales_restored
FROM DISK = N'D:\restore\Sales_20261116T010000Z.bak'
WITH MOVE N'Sales'     TO N'C:\Program Files\Microsoft SQL Server\MSSQL16.SQLEXPRESS\MSSQL\DATA\Sales_restored.mdf',
     MOVE N'Sales_log' TO N'C:\Program Files\Microsoft SQL Server\MSSQL16.SQLEXPRESS\MSSQL\DATA\Sales_restored_log.ldf',
     CHECKSUM, STATS = 10;
```

## 4b. Overwrite the live database (only on the client's explicit request)

1. Make sure nobody is working in the application. Stop the client's application services if needed.
2. Take a fresh safety backup of the current state first: `& $bm backup --db Sales`.
3. Then:

```sql
ALTER DATABASE Sales SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
RESTORE DATABASE Sales
FROM DISK = N'D:\restore\Sales_20261116T010000Z.bak'
WITH REPLACE, CHECKSUM, STATS = 10;
ALTER DATABASE Sales SET MULTI_USER;
```

Backups are `COPY_ONLY` full backups, so they don't interfere with any other backup chain the client may have.
After `REPLACE`, the database is in the state of the backup; anything written after it is gone.

## 5. After the restore

- **Logins and users.** A restore to the same server keeps the users mapped. On another server, fix orphaned users:
  `ALTER USER backup_user WITH LOGIN = backup_user;`
- **Let the client check** the restored data.
- **Clean up:** delete the `.bak` from `D:\restore` (it is unencrypted), and drop `Sales_restored` when the client is done.
- **Record it** in the client's ticket: which backup (file name, id), where it was restored to, and who checked it.

## Restoring elsewhere (client machine dead)

> **Danger:** a normal install on the replacement machine would back up *its* databases into the client's Drive and
> apply retention there (`KEEP_LAST`/`KEEP_DAYS`). With the same `SERVER_NAME` and database names, that rotates
> the client's real backups out. Follow these steps exactly.

1. On a Windows machine with SQL Server 2016 or newer **of the same or a newer version** as the client's, download
   `install.ps1` from the release and run it with **`-RestoreOnly`**, which installs without a scheduled task and
   without a first backup:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1 -RestoreOnly
   ```
   Fill in the env file:
   - `BACKUP_ENCRYPTION_KEY`: the client's key from the password manager;
   - `GOOGLE_EMAIL`: the client's account;
   - `SERVER_NAME`: **leave empty** (the replacement machine's own name). Never set it to the client's server name.
   - The `SQL_*` settings describe this machine's SQL Server so that `check` passes.
2. Sign in with the **client's** Google account when the installer asks (the client may need to approve it).
   `drive.file` access is tied to our OAuth client, not to a machine, so the client's backups are visible.
3. Make sure the installer printed "Restore-only install". If you forgot `-RestoreOnly`, immediately run
   `Unregister-ScheduledTask -TaskName 'PunkDuck Backup Manager' -Confirm:$false`. The first backup it made went to
   `MSSQL Backups/<this machine's name>/`, a separate folder (because `SERVER_NAME` differs); delete that folder in
   the client's Drive. The client's own folder is not affected.
4. Find the client's server folder name with `& $bm list` (the `server/db` column), then continue with steps 1 to 5,
   always adding `--server <client's server name>`:
   ```powershell
   & $bm list --server CLIENT-PC --db Sales
   & $bm download latest --server CLIENT-PC --db Sales --out D:\restore
   ```
5. When done, uninstall with `uninstall.ps1 -Purge`. That revokes the sign-in and deletes the key from this machine.
   Backups on Drive are not touched.

## Troubleshooting

| Message | Meaning |
| --- | --- |
| `not logged in to Google` / `invalid_grant` | The sign-in is missing or was revoked. Run `& $bm auth login` |
| `no backups found for database "X"` | Wrong name (case-sensitive, as in `SQL_DATABASES`), wrong Google account, or a different `SERVER_NAME`. Use `list` without filters |
| `downloaded file checksum mismatch` | The download was damaged. Run it again |
| `decryption failed: wrong key or corrupted file` | Almost always the wrong `BACKUP_ENCRYPTION_KEY`. Take the one stored for **this client** in the password manager |
| `... already exists (use --force to overwrite)` | A `.bak` with that name is already in the output folder |
| SQL error 3241 / "media family is incorrectly formed" | The `.bak` is from a newer SQL Server version than the one you restore to |
