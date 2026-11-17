/*
  backup-manager: manual SQL Server preparation
  =============================================

  Use this ONLY when the installer cannot prepare SQL Server itself, i.e. when the technician
  running install.ps1 is not a SQL Server sysadmin (or install.ps1 -SkipSqlSetup was used because
  the client's DBA manages SQL Server). Normally the installer does all of this automatically.

  Who runs it: a SQL Server sysadmin (e.g. the client's DBA), in SSMS, connected to the SQL Server
  on the machine where backup-manager is installed. Running it again is safe.

  Before running, replace (Ctrl+H in SSMS):
    backup_user          -> SQL_USER from backup-manager.env (keep backup_user if it is empty)
    <strong password>    -> a new strong password: letters and digits, at least 16 characters.
                            Do not use # or quotes. Put the same password into SQL_PASSWORD
                            in C:\ProgramData\backup-manager\backup-manager.env.
    Sales                -> the first database in SQL_DATABASES; copy step 3 for every other one.

  What the program needs, and why:
    - a SQL login (the program uses SQL authentication over TCP);
    - BACKUP DATABASE on each database (role db_backupoperator);
    - CREATE DATABASE in master: RESTORE VERIFYONLY, which checks every backup, requires it.
      Without it every backup fails with Msg 262 / Msg 3013.

  Server settings this script does NOT change (they need a SQL Server restart; ask the DBA):
    - Mixed-mode authentication: SSMS > server Properties > Security >
      "SQL Server and Windows Authentication mode", then restart the SQL Server service.
    - TCP/IP: SQL Server Configuration Manager > SQL Server Network Configuration >
      Protocols for <instance> > TCP/IP > Enabled, then restart the SQL Server service.
    - Named instance (e.g. SQLEXPRESS): the "SQL Server Browser" service must be Automatic and
      running, unless SQL_PORT is set to the instance's fixed port.
*/

-- 1. The login. CHECK_EXPIRATION = OFF: a password-expiry policy must never silently stop the
--    nightly backups. Existing login: only the options are set, the password is left alone.
USE master;
IF SUSER_ID(N'backup_user') IS NULL
    CREATE LOGIN [backup_user] WITH PASSWORD = N'<strong password>', CHECK_POLICY = ON;
ALTER LOGIN [backup_user] WITH CHECK_EXPIRATION = OFF, DEFAULT_DATABASE = [master];
ALTER LOGIN [backup_user] ENABLE;
GO

-- 2. master: a user for the login and CREATE DATABASE (needed by RESTORE VERIFYONLY).
USE master;
IF DATABASE_PRINCIPAL_ID(N'backup_user') IS NULL
    CREATE USER [backup_user] FOR LOGIN [backup_user];
ELSE
    ALTER USER [backup_user] WITH LOGIN = [backup_user];   -- re-links an orphaned user
GRANT CREATE DATABASE TO [backup_user];
GO

-- 3. Each database in SQL_DATABASES: a user for the login, member of db_backupoperator.
--    Copy this block for every other database and change the name after USE.
USE [Sales];
IF DATABASE_PRINCIPAL_ID(N'backup_user') IS NULL
    CREATE USER [backup_user] FOR LOGIN [backup_user];
ELSE
    ALTER USER [backup_user] WITH LOGIN = [backup_user];   -- e.g. after a restore from another server
ALTER ROLE db_backupoperator ADD MEMBER [backup_user];
GO

-- 4. Check: then run "backup-manager check" on the machine. It must show
--    "Verify permission: ... OK" and "Database Sales: ONLINE, BACKUP permission OK".
