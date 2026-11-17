<#
.SYNOPSIS
    Install or update PunkDuck backup-manager on Windows 10/11 x64.

.DESCRIPTION
    Run in Windows PowerShell 5.1 as Administrator. Safe to run again: an update replaces only
    the program files and keeps the settings (env file) and the Google sign-in.

.PARAMETER Version
    Release to install, e.g. 1.2.0. Default: the latest release.

.PARAMETER ZipPath
    Install from a local backup-manager-<version>-win-x64.zip instead of downloading it.
    The matching .sha256 file must be next to it.

.PARAMETER RestoreOnly
    Restore machine for another client's backups (see RESTORE.md): skip the scheduled task and the first backup,
    so nothing is ever uploaded from this machine.

.EXAMPLE
    irm https://github.com/arsenhuman/PunkDuck-Anchor/releases/latest/download/install.ps1 | iex

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Version 1.2.0
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$ZipPath,
    [switch]$RestoreOnly,
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
            return $Matches[1].Trim().Trim("'").Trim('"')
        }
    }
    return ''
}

function Set-EnvValue([string]$Path, [string]$Key, [string]$Value) {
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
    if ([Environment]::OSVersion.Version.Major -ne 10 -or $os.ProductType -ne 1 -or $arch -ne 'AMD64') {
        throw "Only Windows 10/11 x64 is supported (found: $($os.Caption), $arch)."
    }
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

    Expand-Archive -Path $Zip -DestinationPath $staging -Force
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
    Write-Host 'Leave BACKUP_ENCRYPTION_KEY empty: a key is generated in the next step.' -ForegroundColor Yellow
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

function Install-BackupManager {
    Write-Step '1/10 Checking prerequisites'
    Assert-Prerequisites

    Write-Step '2/10 Getting the release package'
    $zip = Get-Package

    Write-Step "3/10 Installing program files to $InstallDir"
    Install-ProgramFiles $zip

    Write-Step "4/10 Settings ($EnvFile)"
    New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
    Lock-Folder $DataDir   # before any secret is written there
    Initialize-EnvFile

    Write-Step '5/10 Encryption key'
    Initialize-EncryptionKey

    Write-Step '6/10 Restricting folder access to SYSTEM and Administrators'
    Lock-Folder $InstallDir
    Lock-Folder $DataDir

    Write-Step '7/10 Checking settings, SQL Server and backup folder'
    if ((Invoke-App check --skip-auth) -ne 0) {
        throw "Some checks failed (see above). Fix them in $EnvFile and run the installer again."
    }

    Write-Step '8/10 Google sign-in'
    if ((Invoke-App auth status) -ne 0) {
        if ((Invoke-App auth login) -ne 0) { throw 'Google sign-in failed.' }
    }
    # Full check, now including Google: stops if the wrong account was signed in (GOOGLE_EMAIL).
    if ((Invoke-App check) -ne 0) {
        throw 'The Google check failed (see above). Fix it (auth logout + auth login) and run the installer again.'
    }

    if ($RestoreOnly) {
        Write-Host ''
        Write-Host 'Restore-only install: no scheduled task, no backup. See RESTORE.md.' -ForegroundColor Green
        return
    }

    Write-Step '9/10 Scheduled task'
    Register-BackupTask

    Write-Step '10/10 First backup'
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
try {
    Install-BackupManager
} catch {
    Write-Host ''
    Write-Host "INSTALL STOPPED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Fix the problem and run the installer again; re-running is safe.' -ForegroundColor Yellow
    # Only exit when run as a file; under "irm | iex" exit would close the technician's window.
    if ($PSCommandPath) { exit 1 }
} finally {
    Pop-Location
}
