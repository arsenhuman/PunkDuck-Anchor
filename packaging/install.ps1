<#
.SYNOPSIS
    Install or update PunkDuck backup-manager on Windows 10/11 or Windows Server 2016+ (x64).

.DESCRIPTION
    Run in Windows PowerShell 5.1 as Administrator. Safe to run again: an update replaces only
    the program files and keeps the settings (env file) and the Google sign-in.

.PARAMETER Version
    Release to install, e.g. 1.2.0. Default: the latest release.

.PARAMETER ZipPath
    Install from a local backup-manager-<version>-win-x64.zip instead of downloading it.
    The matching .sha256 file must be next to it.

.PARAMETER RestoreOnly
    Restore machine for another client's backups (see RESTORE.md): skip SQL Server preparation, the SQL checks,
    the scheduled task and the first backup, so nothing is ever uploaded from this machine.

.PARAMETER SkipSqlSetup
    Do not prepare SQL Server (login, permissions, mixed mode, TCP/IP). For machines where the client's DBA
    manages SQL Server: the DBA runs sql-prepare.sql from the program folder instead.

.EXAMPLE
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
    irm https://github.com/arsenhuman/PunkDuck-Anchor/releases/latest/download/install.ps1 | iex

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Version 1.2.0
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$ZipPath,
    [switch]$RestoreOnly,
    [switch]$SkipSqlSetup,
    [string]$Repo = 'arsenhuman/PunkDuck-Anchor'
)

# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads BOM-less scripts as ANSI.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar

$AppName    = 'backup-manager'
$TaskName   = 'PunkDuck Backup Manager'
$InstallDir = Join-Path $env:ProgramFiles $AppName
$DataDir    = Join-Path $env:ProgramData $AppName
$EnvFile    = Join-Path $DataDir "$AppName.env"
$LogDir     = Join-Path $DataDir 'logs'
$Launcher   = Join-Path $InstallDir "$AppName.cmd"

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host "==> $Text" -ForegroundColor Cyan
}

# QuickEdit mode of the classic console: a click in the window starts a text selection, and while a
# selection is active every write to the console blocks, so the installer looks frozen until a key is
# pressed. Turn it off for the install and restore the technician's setting afterwards.
# Returns the previous console mode, or $null when there is no classic console (nothing to restore).
function Disable-QuickEdit {
    try {
        if (-not ('PunkDuck.ConsoleMode' -as [type])) {
            Add-Type -Namespace PunkDuck -Name ConsoleMode -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GetStdHandle(int nStdHandle);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);
'@
        }
        $handle = [PunkDuck.ConsoleMode]::GetStdHandle(-10)   # STD_INPUT_HANDLE
        $mode = [uint32]0
        if (-not [PunkDuck.ConsoleMode]::GetConsoleMode($handle, [ref]$mode)) { return $null }
        # ENABLE_QUICK_EDIT_MODE = 0x40 off; ENABLE_EXTENDED_FLAGS = 0x80 on, or the change is ignored.
        $new = ($mode -band (-bnot [uint32]0x40)) -bor [uint32]0x80
        if (-not [PunkDuck.ConsoleMode]::SetConsoleMode($handle, $new)) { return $null }
        return $mode
    } catch {
        return $null
    }
}

function Restore-ConsoleMode($Mode) {
    if ($null -eq $Mode) { return }
    try {
        [void][PunkDuck.ConsoleMode]::SetConsoleMode([PunkDuck.ConsoleMode]::GetStdHandle(-10), [uint32]$Mode)
    } catch { }
}

# Run backup-manager.cmd with the console attached (needed for the interactive sign-in).
# Returns the exit code. Native stderr must not turn into terminating errors.
function Invoke-App {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Launcher @Arguments | Out-Host
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $saved
    }
}

function Get-EnvValue([string]$Path, [string]$Key) {
    foreach ($line in [IO.File]::ReadAllLines($Path)) {
        if ($line -match "^\s*$Key\s*=(.*)$") {
            $v = $Matches[1].Trim()
            if ($v.Length -ge 2 -and "'`"``".Contains([string]$v[0]) -and $v[-1] -eq $v[0]) { return $v.Substring(1, $v.Length - 2) }
            return $v.Trim("'").Trim('"')
        }
    }
    return ''
}

# How a value is written to the env file so that src/envconfig.js reads it back unchanged:
# unquoted unless it has "#" (refused unquoted), a leading quote or outer spaces; then in single
# quotes, or backticks if it contains a single quote. Never double quotes: they turn \n into a newline.
function Format-EnvValue([string]$Value) {
    if ($Value -notmatch '#' -and $Value -notmatch '^[''"`]' -and $Value -eq $Value.Trim()) { return $Value }
    if (-not $Value.Contains("'")) { return "'$Value'" }
    if (-not $Value.Contains('`')) { return "``$Value``" }
    throw "This value contains both ' and `` and cannot be written to the settings file: $Value"
}

function Set-EnvValue([string]$Path, [string]$Key, [string]$Value) {
    $Value = Format-EnvValue $Value
    $lines = New-Object 'System.Collections.Generic.List[string]'
    $lines.AddRange([IO.File]::ReadAllLines($Path))
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match "^\s*$Key\s*=") {
            $lines[$i] = "$Key=$Value"
            $found = $true
            break
        }
    }
    if (-not $found) { $lines.Add("$Key=$Value") }
    [IO.File]::WriteAllLines($Path, $lines, (New-Object System.Text.UTF8Encoding($false)))
}

# SQL_INSTANCE values of the SQL Server instances on this machine: '' is the default instance.
function Get-SqlInstanceNames {
    @(Get-Service -Name 'MSSQLSERVER', 'MSSQL$*' -ErrorAction SilentlyContinue | ForEach-Object { ConvertTo-SqlInstanceName $_.Name })
}

function ConvertTo-SqlInstanceName([string]$ServiceName) {
    if ($ServiceName -eq 'MSSQLSERVER') { return '' }
    return $ServiceName.Substring(6)
}

function Format-SqlInstanceNames([string[]]$Names) {
    if ($null -eq $Names -or $Names.Count -eq 0) { return 'none' }
    ($Names | ForEach-Object { if ($_) { $_ } else { '(empty) = default instance' } }) -join ', '
}

# Only SYSTEM and BUILTIN\Administrators get access (SIDs, so it works on any Windows language).
# The root is locked first; only then are the children reset so they inherit from the locked root.
# At no point is anything below $Path readable by other users.
function Lock-Folder([string]$Path) {
    & icacls.exe $Path /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls could not restrict access to $Path" }
    if (Get-ChildItem -Force -Path $Path | Select-Object -First 1) {
        & icacls.exe (Join-Path $Path '*') /reset /T /C /Q | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "icacls /reset failed below $Path" }
    }
}

function Assert-Prerequisites {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run PowerShell as Administrator (right-click > Run as administrator) and start the installer again.'
    }
    if ($PSVersionTable.PSVersion.Major -lt 5) {
        throw "Windows PowerShell 5.1 is required (found $($PSVersionTable.PSVersion))."
    }
    $os = Get-CimInstance Win32_OperatingSystem
    $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $v = [Environment]::OSVersion.Version
    if (-not (Test-SupportedWindows $v.Major $v.Build ([int]$os.ProductType) $arch)) {
        throw "Only Windows 10/11 and Windows Server 2016 or newer, 64-bit, are supported (found: $($os.Caption), $arch)."
    }
}

# Windows 10/11 or Windows Server 2016+ (incl. a domain controller), x64: what the bundled Node 22 supports.
# ProductType: 1 workstation, 2 domain controller, 3 server. Server 2016 is build 14393.
function Test-SupportedWindows([int]$Major, [int]$Build, [int]$ProductType, [string]$Arch) {
    if ($Arch -ne 'AMD64' -or $Major -ne 10) { return $false }
    if ($ProductType -eq 1) { return $true }
    return ($ProductType -eq 2 -or $ProductType -eq 3) -and $Build -ge 14393
}

function Get-Package {
    # Returns the path of a verified zip.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $tmp = Join-Path $env:TEMP "$AppName-install"
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null

    if ($ZipPath) {
        $zip = $ZipPath   # already resolved to a full path at startup
        $shaFile = "$zip.sha256"
        if (-not (Test-Path $shaFile)) { throw "Missing $shaFile next to the zip." }
    } else {
        if (-not $Version) {
            $rel = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = "$AppName-installer" }
            $Version = $rel.tag_name
        }
        $script:Version = $Version -replace '^v', ''
        if ($script:Version -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid version '$Version' (expected e.g. 1.2.0)." }
        $name = "$AppName-$($script:Version)-win-x64.zip"
        $base = "https://github.com/$Repo/releases/download/v$($script:Version)"
        $zip = Join-Path $tmp $name
        $shaFile = "$zip.sha256"
        Write-Host "Downloading $name ..."
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$name" -OutFile $zip
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$name.sha256" -OutFile $shaFile
    }

    $expected = ((Get-Content -Raw $shaFile).Trim() -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLowerInvariant()
    if ($expected -ne $actual) { throw "SHA-256 mismatch for $zip (download corrupted?). Expected $expected, got $actual." }
    Write-Host "SHA-256 verified: $actual"
    return $zip
}

function Install-ProgramFiles([string]$Zip) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task -and $task.State -eq 'Running') {
        throw 'A backup is running right now. Wait until it finishes (Task Scheduler) and run the installer again.'
    }
    $staging = "$InstallDir.new"
    $old = "$InstallDir.old"
    foreach ($p in @($staging, $old)) { if (Test-Path $p) { Remove-Item -Recurse -Force $p } }

    # Expand-Archive in Windows PowerShell 5.1 takes minutes for the ~9000 files in the package.
    Write-Host 'Extracting ...'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($Zip, $staging)
    if (-not (Test-Path (Join-Path $staging 'node.exe')) -or -not (Test-Path (Join-Path $staging "$AppName.cmd"))) {
        Remove-Item -Recurse -Force $staging
        throw 'The package is incomplete (node.exe or the launcher is missing).'
    }
    if (Test-Path $InstallDir) { Rename-Item -Path $InstallDir -NewName "$AppName.old" }
    try {
        Rename-Item -Path $staging -NewName $AppName
    } catch {
        if (Test-Path $old) { Rename-Item -Path $old -NewName $AppName }
        throw
    }
    if (Test-Path $old) { Remove-Item -Recurse -Force $old }
}

function Initialize-EnvFile {
    if (Test-Path $EnvFile) {
        Write-Host "Keeping existing settings: $EnvFile"
        return
    }
    Copy-Item -Path (Join-Path $InstallDir "$AppName.env.template") -Destination $EnvFile
    Write-Host "Created $EnvFile from the template."
    Write-Host 'Fill in the settings in Notepad, save (Ctrl+S) and close Notepad.' -ForegroundColor Yellow
    if (-not $RestoreOnly) {
        Write-Host 'Required: SQL_DATABASES (the client''s databases as shown in SSMS) and SQL_INSTANCE for a named instance.' -ForegroundColor Yellow
        if ($SkipSqlSetup) {
            Write-Host 'Required with -SkipSqlSetup: SQL_BACKUP_DIR, the folder SQL Server writes backups to (SSMS > server Properties > Database Settings > Backup).' -ForegroundColor Yellow
        } else {
            Write-Host 'Leave SQL_BACKUP_DIR empty: the installer reads the backup folder from SQL Server on this machine.' -ForegroundColor Yellow
        }
        $instances = @(Get-SqlInstanceNames)
        if ($instances.Count) {
            Write-Host "SQL Server instances on this machine (SQL_INSTANCE): $(Format-SqlInstanceNames $instances)" -ForegroundColor Yellow
        }
    }
    Write-Host 'Leave BACKUP_ENCRYPTION_KEY empty: a key is generated in the next step.' -ForegroundColor Yellow
    if (-not $RestoreOnly) {
        Write-Host 'SQL_USER / SQL_PASSWORD: leave both empty and the installer creates a SQL login,' -ForegroundColor Yellow
        Write-Host '  or enter an existing SQL login and its password to use that one.' -ForegroundColor Yellow
    }
    Start-Process -FilePath 'notepad.exe' -ArgumentList "`"$EnvFile`"" -Wait
    # Windows 11 Notepad may return immediately (tabs in an already open window), so ask as well.
    Read-Host 'Press Enter when the file is saved' | Out-Null
}

function Initialize-EncryptionKey {
    if (Get-EnvValue $EnvFile 'BACKUP_ENCRYPTION_KEY') { return }
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $key = ((& $Launcher keygen) | Out-String).Trim() } finally { $ErrorActionPreference = $saved }
    if ($LASTEXITCODE -ne 0 -or -not $key) { throw 'Could not generate an encryption key.' }
    Set-EnvValue $EnvFile 'BACKUP_ENCRYPTION_KEY' $key

    Write-Host ''
    Write-Host '=====================================================================' -ForegroundColor Yellow
    Write-Host ' NEW ENCRYPTION KEY - shown only this once' -ForegroundColor Yellow
    Write-Host ''
    Write-Host "   $key" -ForegroundColor White
    Write-Host ''
    try {
        Set-Clipboard -Value $key -ErrorAction Stop
        Write-Host ' The key is also copied to the clipboard: paste it with Ctrl+V.' -ForegroundColor Yellow
    } catch { }
    Write-Host ' Store it NOW in the company password manager under this client.' -ForegroundColor Yellow
    Write-Host ' Without it, the backups of this machine can never be restored.' -ForegroundColor Yellow
    Write-Host '=====================================================================' -ForegroundColor Yellow
    do {
        $answer = Read-Host 'Type SAVED when the key is stored in the password manager'
    } until ($answer -eq 'SAVED')
}

function Register-BackupTask {
    $time = Get-EnvValue $EnvFile 'BACKUP_TIME'
    if (-not $time) { $time = '02:00' }
    $at = [datetime]::ParseExact($time, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)

    $action    = New-ScheduledTaskAction -Execute "`"$Launcher`"" -Argument 'backup' -WorkingDirectory $InstallDir
    $trigger   = New-ScheduledTaskTrigger -Daily -At $at
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Hours 12) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
        -Settings $settings -Description 'Backs up SQL Server databases to Google Drive (backup-manager).' -Force | Out-Null
    Write-Host "Scheduled task '$TaskName': daily at $time as SYSTEM."
}

# ---------------------------------------------------------------------------------------------
# SQL Server preparation (step 7)
#
# Security invariant: every T-SQL text below is a constant single-quoted string. Login names,
# database names and the password reach SQL Server only as SqlParameters; DDL that cannot take
# parameters (CREATE LOGIN/USER, ALTER ROLE, GRANT) is built INSIDE T-SQL with QUOTENAME() and run
# with sp_executesql. Never build SQL text in PowerShell. test/install-functions.ps1 enforces this.
# ---------------------------------------------------------------------------------------------

$SqlWhoAmI = 'SELECT CAST(IS_SRVROLEMEMBER(''sysadmin'') AS int) AS is_sysadmin, SUSER_SNAME() AS login_name;'

$SqlDatabaseState = 'SELECT state_desc, CAST(is_read_only AS int) AS is_read_only FROM sys.databases WHERE name = @db;'

$SqlLoginType = 'SELECT type FROM sys.server_principals WHERE name = @login;'

$SqlUserDatabases = 'SELECT name FROM sys.databases WHERE database_id > 4 ORDER BY name;'

# SQL Server 2012+: the instance's default backup folder (SSMS > server Properties > Database Settings).
$SqlDefaultBackupPath = 'SELECT CAST(SERVERPROPERTY(''InstanceDefaultBackupPath'') AS nvarchar(4000));'

# Creates the login, or resets its password if it exists. Returns 'created' or 'password reset'.
$SqlSetLoginPassword = @'
DECLARE @result nvarchar(20) = CASE WHEN SUSER_ID(@login) IS NULL THEN N'created' ELSE N'password reset' END;
DECLARE @sql nvarchar(max);
IF @result = N'created'
    SET @sql = N'CREATE LOGIN ' + QUOTENAME(@login) + N' WITH PASSWORD = N' + QUOTENAME(@pw, '''') + N', CHECK_POLICY = ON';
ELSE
    SET @sql = N'ALTER LOGIN ' + QUOTENAME(@login) + N' WITH PASSWORD = N' + QUOTENAME(@pw, '''');
EXEC sys.sp_executesql @sql;
SELECT @result;
'@

# A password-expiry policy must never silently stop the nightly backups.
$SqlLoginOptions = @'
DECLARE @sql nvarchar(max) = N'ALTER LOGIN ' + QUOTENAME(@login) + N' WITH CHECK_EXPIRATION = OFF, DEFAULT_DATABASE = [master]; '
    + N'ALTER LOGIN ' + QUOTENAME(@login) + N' ENABLE;';
EXEC sys.sp_executesql @sql;
'@

# Runs $SqlUserGrantsInner in database @db (<db>.sys.sp_executesql runs in that database).
$SqlInDatabase = @'
DECLARE @proc nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';
DECLARE @result nvarchar(20);
EXEC @proc @inner, N'@login sysname, @isMaster int, @result nvarchar(20) OUTPUT',
    @login = @login, @isMaster = @isMaster, @result = @result OUTPUT;
SELECT @result;
'@

# In the current database: make sure a user maps to the login, then grant what backup-manager needs.
# master: GRANT CREATE DATABASE (RESTORE VERIFYONLY needs it). Other databases: db_backupoperator.
# Returns 'created', 'remapped' (orphaned user after a restore from another server) or 'kept'.
$SqlUserGrantsInner = @'
DECLARE @sid varbinary(85) = SUSER_SID(@login);
DECLARE @user sysname, @sql nvarchar(max);
SELECT @user = name FROM sys.database_principals WHERE sid = @sid;
IF @user IS NOT NULL
    SET @result = N'kept';
ELSE IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = @login)
BEGIN
    IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = @login AND type = 'S')
        THROW 50001, N'A database principal with the name of SQL_USER exists but is not a SQL user. Choose another SQL_USER.', 1;
    SET @sql = N'ALTER USER ' + QUOTENAME(@login) + N' WITH LOGIN = ' + QUOTENAME(@login);
    EXEC sys.sp_executesql @sql;
    SELECT @user = @login, @result = N'remapped';
END
ELSE
BEGIN
    SET @sql = N'CREATE USER ' + QUOTENAME(@login) + N' FOR LOGIN ' + QUOTENAME(@login);
    EXEC sys.sp_executesql @sql;
    SELECT @user = @login, @result = N'created';
END
IF @user <> N'dbo'
BEGIN
    IF @isMaster = 1
    BEGIN
        SET @sql = N'GRANT CREATE DATABASE TO ' + QUOTENAME(@user);
        EXEC sys.sp_executesql @sql;
    END
    ELSE IF NOT EXISTS (
        SELECT 1 FROM sys.database_role_members rm
        JOIN sys.database_principals r ON r.principal_id = rm.role_principal_id
        JOIN sys.database_principals m ON m.principal_id = rm.member_principal_id
        WHERE r.name = N'db_backupoperator' AND m.name = @user)
    BEGIN
        SET @sql = N'ALTER ROLE db_backupoperator ADD MEMBER ' + QUOTENAME(@user);
        EXEC sys.sp_executesql @sql;
    END
END
'@

$SqlIntegratedOnly = 'SELECT CAST(SERVERPROPERTY(''IsIntegratedSecurityOnly'') AS int);'

# What SSMS does for "SQL Server and Windows Authentication mode". Takes effect after a restart.
$SqlEnableMixedMode = 'EXEC master.dbo.xp_instance_regwrite N''HKEY_LOCAL_MACHINE'', N''Software\Microsoft\MSSQLServer\MSSQLServer'', N''LoginMode'', REG_DWORD, 2;'

$SqlPing = 'SELECT 1;'

$SqlPrepareScript = Join-Path $InstallDir 'sql-prepare.sql'

# Set by Connect-SqlAdminLogin when the technician signs in with a SQL login (e.g. sa) instead of Windows.
# The password stays in a read-only SecureString, is never written anywhere and is dropped after step 7.
$script:SqlAdminCredential = $null

# ---- pure helpers (tested by test/install-functions.ps1) ----

# Same rule as the program (src/envconfig.js isLocalSqlHost).
function Test-LocalSqlHost([string]$SqlHost, [string]$ComputerName = $env:COMPUTERNAME) {
    $h = "$SqlHost".Trim().ToLowerInvariant()
    if (-not $h) { return $false }
    if (@('localhost', '127.0.0.1', '::1', '.', '(local)') -contains $h) { return $true }
    return [bool]($ComputerName -and $h -eq $ComputerName.ToLowerInvariant())
}

# Service, shared-memory data source and WMI instance name for SQL_INSTANCE / SQL_PORT.
# NeedsBrowser mirrors src/envconfig.js: a named instance is looked up through SQL Browser unless
# SQL_PORT is set to something other than 1433.
function Resolve-SqlInstance([string]$Instance, [string]$Port) {
    $name = "$Instance".Trim()
    $p = "$Port".Trim()
    if (-not $name) {
        return @{ ServiceName = 'MSSQLSERVER'; DataSource = 'lpc:.'; InstanceName = 'MSSQLSERVER'; IsNamed = $false; NeedsBrowser = $false }
    }
    return @{
        ServiceName  = 'MSSQL$' + $name
        DataSource   = 'lpc:.\' + $name
        InstanceName = $name
        IsNamed      = $true
        NeedsBrowser = (-not $p -or $p -eq '1433')
    }
}

# SQL_USER must be a plain SQL login name (not DOMAIN\user), at most 128 characters.
function Test-SqlLoginName([string]$Name) {
    if (-not $Name -or $Name.Length -gt 128) { return $false }
    if ($Name -match '[\\\x00-\x1f]') { return $false }
    return $true
}

# Name of the login the installer creates when SQL_USER and SQL_PASSWORD are both empty.
$DefaultSqlUser = 'backup_user'

# What to do with the SQL login. $User is SQL_USER after the default was applied ('' never reaches here).
#   use:      the technician gave SQL_USER and SQL_PASSWORD of an existing login -> keep it as it is
#   create:   the login does not exist -> create it (with SQL_PASSWORD, or a generated one when empty)
#   reset:    our own default login exists but the env file lost its password -> new generated password
#   error:    Message says what to fix
function Get-SqlLoginPlan([string]$User, [bool]$HasPassword, [bool]$LoginExists, [string]$DefaultUser = 'backup_user') {
    if (-not $LoginExists) {
        return @{ Action = 'create'; GeneratePassword = (-not $HasPassword) }
    }
    if ($HasPassword) { return @{ Action = 'use' } }
    if ($User -eq $DefaultUser) { return @{ Action = 'reset' } }
    return @{
        Action  = 'error'
        Message = "The SQL login '$User' already exists, but SQL_PASSWORD is empty. Enter its password in SQL_PASSWORD, or empty SQL_USER to let the installer create its own login ($DefaultUser)."
    }
}

function Split-DatabaseList([string]$Value) {
    return @("$Value" -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

# Letters and digits only (safe in the env file and in T-SQL), with at least one upper-case letter,
# one lower-case letter and one digit, so it passes CHECK_POLICY. Unbiased (rejection sampling).
function New-SqlLoginPassword([int]$Length = 32) {
    $chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    $limit = 256 - (256 % $chars.Length)
    $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
    try {
        $buf = New-Object byte[] 1
        do {
            $sb = New-Object System.Text.StringBuilder
            while ($sb.Length -lt $Length) {
                $rng.GetBytes($buf)
                if ($buf[0] -lt $limit) { [void]$sb.Append($chars[$buf[0] % $chars.Length]) }
            }
            $pw = $sb.ToString()
        } until ($pw -cmatch '[A-Z]' -and $pw -cmatch '[a-z]' -and $pw -match '[0-9]')
        return $pw
    } finally {
        $rng.Dispose()
    }
}

# SQL Server WMI provider namespaces (ComputerManagement13 = 2016 ... 17 = 2025), newest first.
# All of them, not just the newest: another SQL Server version (or its leftovers) can leave a newer
# namespace that does not serve this instance or is not registered at all ("Invalid class").
function Select-SqlWmiNamespace([string[]]$Names) {
    $versions = @(foreach ($n in $Names) { if ($n -match '^ComputerManagement(\d+)$') { [int]$Matches[1] } })
    return @($versions | Sort-Object -Descending -Unique | ForEach-Object { "root\Microsoft\SqlServer\ComputerManagement$_" })
}

# Default instance: what to do with the IPAll TcpPort. Returns @{ Action = 'set' | 'keep' | 'adopt'; Port }.
#   set:   no static port yet -> set SQL_PORT (1433 if empty); needs a restart
#   keep:  SQL_PORT is already one of the static ports
#   adopt: another static port is configured -> keep it, write it to SQL_PORT (no restart)
function Get-TcpPortPlan([string]$Current, [string]$Wanted) {
    $want = if ("$Wanted".Trim()) { "$Wanted".Trim() } else { '1433' }
    $ports = @("$Current" -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($ports.Count -eq 0) { return @{ Action = 'set'; Port = $want } }
    if ($ports -contains $want) { return @{ Action = 'keep'; Port = $want } }
    return @{ Action = 'adopt'; Port = $ports[0] }
}

# ---- SQL Server access (Windows authentication over shared memory) ----

# Runs one constant T-SQL text with parameters. Strings go in as NVarChar, integers as Int.
# Returns the rows, or the first column of the first row with -Scalar.
function Invoke-SqlAdmin {
    param([string]$DataSource, [string]$Sql, [hashtable]$Params = @{}, [switch]$Scalar)
    $csb = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
    $csb['Data Source'] = $DataSource
    $csb['Integrated Security'] = (-not $script:SqlAdminCredential)
    $csb['Encrypt'] = $false
    $csb['Connect Timeout'] = 15
    $csb['Application Name'] = "$AppName installer"
    if ($script:SqlAdminCredential) {
        # SqlCredential keeps the password out of the connection string.
        $conn = New-Object System.Data.SqlClient.SqlConnection -ArgumentList $csb.ConnectionString, $script:SqlAdminCredential
    } else {
        $conn = New-Object System.Data.SqlClient.SqlConnection($csb.ConnectionString)
    }
    try {
        $conn.Open()
        $cmd = $conn.CreateCommand()
        $cmd.CommandText = $Sql
        $cmd.CommandTimeout = 120
        foreach ($key in $Params.Keys) {
            $value = $Params[$key]
            if ($value -is [int]) {
                $p = $cmd.Parameters.Add("@$key", [System.Data.SqlDbType]::Int)
            } else {
                $value = [string]$value
                $size = if ($value.Length -gt 4000) { -1 } else { 4000 }
                $p = $cmd.Parameters.Add("@$key", [System.Data.SqlDbType]::NVarChar, $size)
            }
            $p.Value = $value
        }
        if ($Scalar) {
            $v = $cmd.ExecuteScalar()
            if ($v -is [DBNull]) { return $null }
            return $v
        }
        $table = New-Object System.Data.DataTable
        $table.Load($cmd.ExecuteReader())
        foreach ($row in $table.Rows) { $row }
    } catch {
        # .NET errors arrive wrapped (MethodInvocationException): find the SqlException and print
        # "Msg 262: ... | Msg 3013: ...", like the program prints SQL errors.
        $ex = $_.Exception
        while ($ex -and -not ($ex -is [System.Data.SqlClient.SqlException])) { $ex = $ex.InnerException }
        if (-not $ex) { throw }
        $msgs = @($ex.Errors | ForEach-Object { "Msg $($_.Number): $($_.Message)" })
        throw ($msgs -join ' | ')
    } finally {
        $conn.Dispose()
    }
}

function Wait-SqlServer([string]$DataSource, [int]$TimeoutSeconds = 90) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            Invoke-SqlAdmin -DataSource $DataSource -Sql $SqlPing -Scalar | Out-Null
            return $true
        } catch {
            Start-Sleep -Seconds 3
        }
    }
    return $false
}

# ---- SQL Server network settings (the WMI provider SQL Server Configuration Manager uses) ----

function Get-SqlWmiNamespace {
    try {
        $names = @(Get-CimInstance -Namespace 'root\Microsoft\SqlServer' -ClassName '__NAMESPACE' -ErrorAction Stop | ForEach-Object { $_.Name })
    } catch {
        return @()
    }
    return Select-SqlWmiNamespace $names
}

# The first namespace (newest first) whose provider lists TCP/IP for the instance.
# Returns @{ Namespace; Tcp }, or $null after printing what each namespace answered.
function Find-SqlTcpProtocol([hashtable]$Inst) {
    $namespaces = @(Get-SqlWmiNamespace)
    if ($namespaces.Count -eq 0) {
        Write-Host 'The SQL Server WMI provider (used by SQL Server Configuration Manager) was not found.' -ForegroundColor Red
        return $null
    }
    $tried = New-Object 'System.Collections.Generic.List[string]'
    foreach ($ns in $namespaces) {
        try {
            $tcp = Get-SqlTcpProtocol $ns $Inst.InstanceName
        } catch {
            $tried.Add("$ns`: $($_.Exception.Message)")
            continue
        }
        if ($tcp) { return @{ Namespace = $ns; Tcp = $tcp } }
        $tried.Add("$ns`: no TCP/IP entry for $($Inst.InstanceName)")
    }
    Write-Host "No SQL Server WMI namespace lists TCP/IP for $($Inst.InstanceName):" -ForegroundColor Red
    foreach ($t in $tried) { Write-Host "  $t" -ForegroundColor Red }
    return $null
}

function Get-SqlTcpProtocol([string]$Namespace, [string]$InstanceName) {
    Get-CimInstance -Namespace $Namespace -ClassName 'ServerNetworkProtocol' -ErrorAction Stop |
        Where-Object { $_.InstanceName -eq $InstanceName -and $_.ProtocolName -eq 'Tcp' } |
        Select-Object -First 1
}

function Get-SqlIpAllProperty([string]$Namespace, [string]$InstanceName, [string]$PropertyName) {
    Get-CimInstance -Namespace $Namespace -ClassName 'ServerNetworkProtocolProperty' -ErrorAction Stop |
        Where-Object { $_.InstanceName -eq $InstanceName -and $_.ProtocolName -eq 'Tcp' -and
                       $_.IPAddressName -eq 'IPAll' -and $_.PropertyName -eq $PropertyName } |
        Select-Object -First 1
}

function Assert-CimResult($Result, [string]$What) {
    if ($Result.ReturnValue -ne 0) { throw "$What failed (WMI return value $($Result.ReturnValue))." }
}

function Write-ManualTcpHelp([hashtable]$Inst) {
    Write-Host 'Enable TCP/IP by hand:' -ForegroundColor Yellow
    Write-Host "  SQL Server Configuration Manager > SQL Server Network Configuration > Protocols for $($Inst.InstanceName)" -ForegroundColor Yellow
    Write-Host '  > TCP/IP > Enabled = Yes; for the default instance also IP Addresses > IPAll > TCP Port = 1433.' -ForegroundColor Yellow
    Write-Host '  Then restart the SQL Server service and run the installer again.' -ForegroundColor Yellow
}

# Stops the SQL Server service, starts it again with the dependent services that were running
# (e.g. SQL Server Agent), and waits until it accepts connections.
function Restart-SqlServer([hashtable]$Inst) {
    $svc = Get-Service -Name $Inst.ServiceName
    $dependents = @($svc.DependentServices | Where-Object { $_.Status -eq 'Running' } | ForEach-Object { $_.Name })
    Write-Host "Restarting $($Inst.ServiceName) ..."
    Stop-Service -Name $Inst.ServiceName -Force
    Start-Service -Name $Inst.ServiceName
    foreach ($d in $dependents) { Start-Service -Name $d }
    if (-not (Wait-SqlServer $Inst.DataSource 90)) {
        throw "SQL Server did not accept connections within 90 seconds after the restart. Check services.msc and the SQL Server error log."
    }
    if ($dependents.Count) { Write-Host "Started again: $($dependents -join ', ')" }
}

function Write-SqlPrepareHelp {
    Write-Host "A SQL Server sysadmin (e.g. the client's DBA) can prepare SQL Server by hand with:" -ForegroundColor Yellow
    Write-Host "  $SqlPrepareScript" -ForegroundColor Yellow
    Write-Host 'Then run the installer again with -SkipSqlSetup (see README, "SQL Server preparation").' -ForegroundColor Yellow
}

# Fallback when the technician's Windows account is not a SQL Server sysadmin: sign in with a SQL login
# such as sa (the Mersoft setup usually creates one). Only works when mixed mode is already on.
# Returns the $SqlWhoAmI row; sets $script:SqlAdminCredential for the rest of step 7.
function Connect-SqlAdminLogin([hashtable]$Inst) {
    Write-Host ''
    Write-Host 'You can sign in with a SQL Server sysadmin login instead (usually sa).' -ForegroundColor Yellow
    Write-Host 'It is used only during this step and is not saved.' -ForegroundColor Yellow
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $name = "$(Read-Host 'SQL Server sysadmin login (Enter for sa, or type SKIP to stop)')".Trim()
        if ($name -eq 'SKIP') { break }
        if (-not $name) { $name = 'sa' }
        if (-not (Test-SqlLoginName $name)) {
            Write-Host "'$name' is not a SQL login name (DOMAIN\user is a Windows account)." -ForegroundColor Red
            continue
        }
        $pw = Read-Host "Password for $name" -AsSecureString
        $pw.MakeReadOnly()
        $script:SqlAdminCredential = New-Object System.Data.SqlClient.SqlCredential -ArgumentList $name, $pw
        try {
            $me = @(Invoke-SqlAdmin -DataSource $Inst.DataSource -Sql $SqlWhoAmI)[0]
        } catch {
            $script:SqlAdminCredential = $null
            Write-Host "Could not sign in as $name`: $($_.Exception.Message)" -ForegroundColor Red
            Write-Host 'Wrong password, the login is disabled, or SQL Server accepts only Windows sign-in (mixed mode off).' -ForegroundColor Yellow
            continue
        }
        if ($me.is_sysadmin -eq 1) { return $me }
        $script:SqlAdminCredential = $null
        Write-Host "$name is not a sysadmin on this SQL Server." -ForegroundColor Red
    }
    Write-SqlPrepareHelp
    throw 'SQL Server preparation needs a SQL Server sysadmin.'
}

# Step 7. Idempotent: running it again changes only what is still missing.
function Initialize-SqlServer {
    $sqlHost = Get-EnvValue $EnvFile 'SQL_HOST'
    if (-not $sqlHost) { $sqlHost = 'localhost' }
    if (-not (Test-LocalSqlHost $sqlHost)) {
        Write-Host "SQL_HOST=$sqlHost is not this machine: SQL Server there is not prepared by the installer." -ForegroundColor Yellow
        Write-Host '  On that SQL Server a sysadmin runs sql-prepare.sql (login, permissions, mixed mode, TCP/IP):' -ForegroundColor Yellow
        Write-Host "    $SqlPrepareScript" -ForegroundColor Yellow
        Write-Host '  In the env file fill in SQL_USER, SQL_PASSWORD, SQL_BACKUP_DIR (the backup folder on that machine)' -ForegroundColor Yellow
        Write-Host '  and SQL_LOCAL_BACKUP_DIR (the same folder as a network share, e.g. \\sqlhost\Backup).' -ForegroundColor Yellow
        Write-Host '  The nightly task runs as SYSTEM: on the share, this computer''s account (DOMAIN\<computer>$) needs' -ForegroundColor Yellow
        Write-Host '  read and delete rights, which only works in a domain. The first backup below runs as you, not as SYSTEM.' -ForegroundColor Yellow
        if (-not (Get-EnvValue $EnvFile 'SQL_BACKUP_DIR')) {
            Write-Host "SQL_BACKUP_DIR is not filled in automatically then: set it in $EnvFile." -ForegroundColor Yellow
        }
        return
    }
    $inst = Resolve-SqlInstance (Get-EnvValue $EnvFile 'SQL_INSTANCE') (Get-EnvValue $EnvFile 'SQL_PORT')
    $login = Get-EnvValue $EnvFile 'SQL_USER'
    $password = Get-EnvValue $EnvFile 'SQL_PASSWORD'
    if (-not $login) {
        if ($password) { throw "SQL_PASSWORD is set but SQL_USER is empty. Fill in both, or empty both to let the installer create a login. Fix it in $EnvFile." }
        $login = $DefaultSqlUser
    }
    if (-not (Test-SqlLoginName $login)) {
        throw "SQL_USER '$login' is not a valid SQL login name (no DOMAIN\user, at most 128 characters). Fix it in $EnvFile."
    }
    $databases = Split-DatabaseList (Get-EnvValue $EnvFile 'SQL_DATABASES')
    if ($databases.Count -eq 0) { throw "SQL_DATABASES is empty. Fix it in $EnvFile." }
    $summary = New-Object 'System.Collections.Generic.List[string]'

    # 1. The service
    $svc = Get-Service -Name $inst.ServiceName -ErrorAction SilentlyContinue
    if (-not $svc) {
        $list = Format-SqlInstanceNames @(Get-SqlInstanceNames)
        throw "SQL Server service $($inst.ServiceName) not found (SQL_INSTANCE values on this machine: $list). Fix SQL_INSTANCE in $EnvFile."
    }
    if ($svc.Status -ne 'Running') {
        Write-Host "Starting $($inst.ServiceName) ..."
        Start-Service -Name $inst.ServiceName
        if (-not (Wait-SqlServer $inst.DataSource 90)) { throw "SQL Server ($($inst.ServiceName)) did not start." }
    }

    # 2. Connect as a sysadmin: the technician's Windows account, else a SQL login such as sa
    $me = $null
    try {
        $me = @(Invoke-SqlAdmin -DataSource $inst.DataSource -Sql $SqlWhoAmI)[0]
        if ($me.is_sysadmin -ne 1) {
            Write-Host "Your Windows account ($($me.login_name)) is not a sysadmin on this SQL Server." -ForegroundColor Yellow
            $me = $null
        }
    } catch {
        Write-Host "Could not connect to SQL Server ($($inst.DataSource)) with your Windows account: $($_.Exception.Message)" -ForegroundColor Yellow
    }
    if (-not $me) { $me = Connect-SqlAdminLogin $inst }
    Write-Host "Connected to $($inst.InstanceName) as $($me.login_name) (sysadmin)."

    # 3. Databases: all must exist, be ONLINE and writable before anything is created
    foreach ($db in $databases) {
        $row = @(Invoke-SqlAdmin -DataSource $inst.DataSource -Sql $SqlDatabaseState -Params @{ db = $db })[0]
        if (-not $row) {
            $existing = @(Invoke-SqlAdmin -DataSource $inst.DataSource -Sql $SqlUserDatabases | ForEach-Object { $_.name })
            $list = if ($existing.Count) { $existing -join ', ' } else { 'none' }
            throw "Database '$db' (SQL_DATABASES) does not exist on $($inst.InstanceName) (databases there: $list). Fix the name in $EnvFile."
        }
        if ($row.state_desc -ne 'ONLINE') { throw "Database '$db' is $($row.state_desc), not ONLINE." }
        if ($row.is_read_only -eq 1) { throw "Database '$db' is read-only: the installer cannot add the backup user. Make it writable or prepare it with sql-prepare.sql." }
    }

    # 3b. Backup folder: SQL Server's own default unless the technician set one
    if (-not (Get-EnvValue $EnvFile 'SQL_BACKUP_DIR')) {
        $backupDir = Invoke-SqlAdmin -DataSource $inst.DataSource -Sql $SqlDefaultBackupPath -Scalar
        if (-not $backupDir) {
            throw "SQL Server did not report its default backup folder. Set SQL_BACKUP_DIR in $EnvFile (SSMS > server Properties > Database Settings > Backup)."
        }
        Set-EnvValue $EnvFile 'SQL_BACKUP_DIR' $backupDir
        $summary.Add("Backup folder: $backupDir (SQL_BACKUP_DIR)")
    }

    # 4. The login: use the one from the env file, or create one (see Get-SqlLoginPlan)
    $loginType = Invoke-SqlAdmin -DataSource $inst.DataSource -Sql $SqlLoginType -Params @{ login = $login } -Scalar
    if ($loginType -and $loginType -ne 'S') {
        throw "A Windows login or group named '$login' exists. SQL_USER must be a SQL login: choose another SQL_USER in $EnvFile."
    }
    $plan = Get-SqlLoginPlan $login ([bool]$password) ([bool]$loginType) $DefaultSqlUser
    if ($plan.Action -eq 'error') { throw "$($plan.Message) ($EnvFile)" }
    if ($plan.Action -eq 'use') {
        $summary.Add("Login $login`: existing login from the env file used, its password and options not changed")
    } else {
        # Change SQL Server first, then the env file: a failure never leaves a password SQL Server doesn't know.
        $generated = $plan.Action -eq 'reset' -or $plan.GeneratePassword
        $pw = if ($generated) { New-SqlLoginPassword } else { $password }
        try {
            $done = Invoke-SqlAdmin -DataSource $inst.DataSource -Sql $SqlSetLoginPassword -Params @{ login = $login; pw = $pw } -Scalar
            Set-EnvValue $EnvFile 'SQL_USER' $login
            if ($generated) { Set-EnvValue $EnvFile 'SQL_PASSWORD' $pw }
        } finally {
            Remove-Variable pw -ErrorAction SilentlyContinue
        }
        $how = if ($generated) { 'random password stored in the env file' } else { 'password from the env file' }
        $summary.Add("Login $login`: $done ($how)")
        # Only for a login the installer manages: an expiry policy must never stop the nightly backups.
        Invoke-SqlAdmin -DataSource $inst.DataSource -Sql $SqlLoginOptions -Params @{ login = $login } | Out-Null
    }

    # 5. Users and grants
    $r = Invoke-SqlAdmin -DataSource $inst.DataSource -Sql $SqlInDatabase -Scalar `
        -Params @{ db = 'master'; inner = $SqlUserGrantsInner; login = $login; isMaster = 1 }
    $summary.Add("master: user $r, CREATE DATABASE granted")
    foreach ($db in $databases) {
        $r = Invoke-SqlAdmin -DataSource $inst.DataSource -Sql $SqlInDatabase -Scalar `
            -Params @{ db = $db; inner = $SqlUserGrantsInner; login = $login; isMaster = 0 }
        $summary.Add("$db`: user $r, db_backupoperator")
    }

    # 6. SQL Browser for a named instance found through it (no SQL Server restart needed)
    if ($inst.NeedsBrowser) {
        $browser = Get-Service -Name 'SQLBrowser' -ErrorAction SilentlyContinue
        if (-not $browser) {
            throw "The SQL Server Browser service is not installed. Set SQL_PORT in $EnvFile to the fixed TCP port of $($inst.InstanceName) instead."
        }
        if ($browser.StartType -ne 'Automatic' -or $browser.Status -ne 'Running') {
            Set-Service -Name 'SQLBrowser' -StartupType Automatic
            Start-Service -Name 'SQLBrowser'
            $summary.Add('SQL Server Browser: set to Automatic and started')
        }
    }

    # 7. Settings that need a SQL Server restart: detect everything first, change nothing yet
    $changes = New-Object 'System.Collections.Generic.List[string]'
    $mixedOff = (Invoke-SqlAdmin -DataSource $inst.DataSource -Sql $SqlIntegratedOnly -Scalar) -eq 1
    if ($mixedOff) { $changes.Add('Enable "SQL Server and Windows Authentication mode" (mixed mode)') }

    $found = Find-SqlTcpProtocol $inst
    if (-not $found) {
        Write-ManualTcpHelp $inst
        throw 'Cannot check the TCP/IP settings automatically.'
    }
    $ns = $found.Namespace
    $tcp = $found.Tcp
    if (-not $tcp.Enabled) { $changes.Add("Enable TCP/IP for $($inst.InstanceName)") }

    $portPlan = $null
    if (-not $inst.IsNamed) {
        $portProp = Get-SqlIpAllProperty $ns $inst.InstanceName 'TcpPort'
        $dynProp = Get-SqlIpAllProperty $ns $inst.InstanceName 'TcpDynamicPorts'
        if (-not $portProp -or -not $dynProp) {
            Write-ManualTcpHelp $inst
            throw 'Cannot read the TCP port settings (IPAll) automatically.'
        }
        $portPlan = Get-TcpPortPlan $portProp.PropertyStrVal (Get-EnvValue $EnvFile 'SQL_PORT')
        if ($portPlan.Action -eq 'set') {
            $changes.Add("Set the static TCP port (IPAll) to $($portPlan.Port), no dynamic ports")
        } elseif ($portPlan.Action -eq 'adopt') {
            Set-EnvValue $EnvFile 'SQL_PORT' $portPlan.Port
            $summary.Add("SQL_PORT set to $($portPlan.Port) (the port SQL Server already uses)")
        }
    }

    if ($changes.Count -eq 0) {
        $summary.Add('Server settings: nothing to change, no restart')
    } else {
        Write-Host ''
        Write-Host 'SQL Server needs these settings changed:' -ForegroundColor Yellow
        foreach ($c in $changes) { Write-Host "  - $c" -ForegroundColor Yellow }
        Write-Host ''
        Write-Host 'Applying this RESTARTS the SQL Server service. Everyone using this SQL Server' -ForegroundColor Yellow
        Write-Host "(the client's application too) is disconnected for about 30 seconds." -ForegroundColor Yellow
        $answer = Read-Host 'Type RESTART to apply now, or press Enter to stop and run the installer again later'
        if ($answer -ne 'RESTART') {
            throw 'Nothing was changed in the SQL Server settings. Run the installer again when a restart is OK.'
        }
        $applied = New-Object 'System.Collections.Generic.List[string]'
        try {
            if ($mixedOff) {
                Invoke-SqlAdmin -DataSource $inst.DataSource -Sql $SqlEnableMixedMode | Out-Null
                $applied.Add('mixed mode')
            }
            if (-not $tcp.Enabled) {
                Assert-CimResult (Invoke-CimMethod -InputObject $tcp -MethodName 'SetEnable') 'Enabling TCP/IP'
                $applied.Add('TCP/IP')
            }
            if ($portPlan -and $portPlan.Action -eq 'set') {
                Assert-CimResult (Invoke-CimMethod -InputObject $portProp -MethodName 'SetStringValue' -Arguments @{ StrValue = $portPlan.Port }) 'Setting the TCP port'
                Assert-CimResult (Invoke-CimMethod -InputObject $dynProp -MethodName 'SetStringValue' -Arguments @{ StrValue = '' }) 'Clearing the dynamic TCP port'
                $applied.Add("TCP port $($portPlan.Port)")
            }
        } catch {
            $done = if ($applied.Count) { $applied -join ', ' } else { 'nothing' }
            throw "Changing the SQL Server settings failed: $($_.Exception.Message) Applied so far: $done (not active until SQL Server restarts). SQL Server was not restarted."
        }
        Restart-SqlServer $inst
        $summary.Add("Server settings changed: $($applied -join ', '); SQL Server restarted")
    }

    Write-Host ''
    Write-Host 'SQL Server preparation:' -ForegroundColor Green
    foreach ($s in $summary) { Write-Host "  $s" }
}

function Install-BackupManager {
    Write-Step '1/11 Checking prerequisites'
    Assert-Prerequisites

    Write-Step '2/11 Getting the release package'
    $zip = Get-Package

    Write-Step "3/11 Installing program files to $InstallDir"
    Install-ProgramFiles $zip

    Write-Step "4/11 Settings ($EnvFile)"
    New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
    Lock-Folder $DataDir   # before any secret is written there
    Initialize-EnvFile

    Write-Step '5/11 Encryption key'
    Initialize-EncryptionKey

    Write-Step '6/11 Restricting folder access to SYSTEM and Administrators'
    Lock-Folder $InstallDir
    Lock-Folder $DataDir

    Write-Step '7/11 Preparing SQL Server'
    if ($RestoreOnly) {
        Write-Host 'Skipped: a restore-only machine does not back up, so SQL Server is not prepared or checked.'
    } elseif ($SkipSqlSetup) {
        Write-Host 'Skipped (-SkipSqlSetup).'
        Write-SqlPrepareHelp
    } else {
        try {
            Initialize-SqlServer
        } finally {
            $script:SqlAdminCredential = $null
            [System.Data.SqlClient.SqlConnection]::ClearAllPools()
        }
    }

    # A restore-only machine never connects to SQL Server from this program: skip the SQL checks.
    $skipSql = @()
    if ($RestoreOnly) { $skipSql = @('--skip-sql') }

    Write-Step '8/11 Checking settings, SQL Server and backup folder'
    if ((Invoke-App check --skip-auth @skipSql) -ne 0) {
        throw "Some checks failed (see above). Fix them in $EnvFile and run the installer again."
    }

    Write-Step '9/11 Google sign-in'
    if ((Invoke-App auth status) -ne 0) {
        if ((Invoke-App auth login) -ne 0) { throw 'Google sign-in failed.' }
    }
    # Full check, now including Google: stops if the wrong account was signed in (GOOGLE_EMAIL).
    if ((Invoke-App check @skipSql) -ne 0) {
        throw 'The Google check failed (see above). Fix it (auth logout + auth login) and run the installer again.'
    }

    if ($RestoreOnly) {
        Write-Host ''
        Write-Host 'Restore-only install: no scheduled task, no backup. See RESTORE.md.' -ForegroundColor Green
        return
    }

    Write-Step '10/11 Scheduled task'
    Register-BackupTask

    Write-Step '11/11 First backup'
    if ((Invoke-App backup) -ne 0) {
        throw "The first backup failed (see above and the log in $LogDir)."
    }

    Write-Host ''
    Write-Host 'backup-manager is installed and the first backup succeeded.' -ForegroundColor Green
    Write-Host "  Settings: $EnvFile"
    Write-Host "  Logs:     $LogDir"
    Write-Host "  Check:    & '$Launcher' check"
}

# Resolve -ZipPath against the technician's folder before the working directory changes.
if ($ZipPath) {
    if (-not (Test-Path -LiteralPath $ZipPath)) {
        Write-Host "INSTALL STOPPED: zip not found: $ZipPath" -ForegroundColor Red
        if ($PSCommandPath) { exit 1 } else { return }
    }
    $ZipPath = (Resolve-Path -LiteralPath $ZipPath).Path
}

Push-Location $env:SystemRoot   # never sit inside the folder we replace
$savedConsoleMode = Disable-QuickEdit
try {
    Install-BackupManager
} catch {
    Write-Host ''
    Write-Host "INSTALL STOPPED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Fix the problem and run the installer again; re-running is safe.' -ForegroundColor Yellow
    # Only exit when run as a file; under "irm | iex" exit would close the technician's window.
    if ($PSCommandPath) { exit 1 }
} finally {
    Restore-ConsoleMode $savedConsoleMode
    Pop-Location
}
