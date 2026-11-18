<#
.SYNOPSIS
    Uninstall PunkDuck backup-manager, or one client of it.

.DESCRIPTION
    Without -Client: removes the scheduled task "PunkDuck Backup Manager" and C:\Program Files\backup-manager.
    Keeps C:\ProgramData\backup-manager (settings, encryption key, Google sign-in, logs) unless -Purge is given.
    Refuses (and changes nothing) while clients installed with install.ps1 -Client still have a scheduled
    task: the program files are shared, so uninstall each client first.

    With -Client <name>: removes only that client's scheduled task "PunkDuck Backup Manager (<name>)".
    Keeps C:\ProgramData\backup-manager-clients\<name> unless -Purge is given. The program files stay.

    Backups on Google Drive are NEVER touched. SQL logins are never dropped.

.PARAMETER Client
    The client to uninstall (the name given to install.ps1 -Client).

.PARAMETER Purge
    Also revoke the Google sign-in and delete the data folder (of the default install, or of -Client).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File "C:\Program Files\backup-manager\uninstall.ps1"

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File "C:\Program Files\backup-manager\uninstall.ps1" -Purge

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File "C:\Program Files\backup-manager\uninstall.ps1" -Client acme -Purge
#>
[CmdletBinding()]
param(
    [string]$Client,
    [switch]$Purge
)

# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads BOM-less scripts as ANSI.

$ErrorActionPreference = 'Stop'

$AppName    = 'backup-manager'
$InstallDir = Join-Path $env:ProgramFiles $AppName
$Launcher   = Join-Path $InstallDir "$AppName.cmd"
$ClientsDir = Join-Path $env:ProgramData "$AppName-clients"

# Copies of the functions in install.ps1 (this script runs without it). test/install-functions.ps1
# checks that both copies give the same answers.
function Test-ClientName([string]$Name) {
    if (-not ($Name -cmatch '^[A-Za-z0-9_-]{1,32}\z')) { return $false }
    if ($Name -match '^(user|con|prn|aux|nul|com[0-9]|lpt[0-9])\z') { return $false }
    return $true
}

function Get-ClientFromTaskName([string]$TaskName) {
    if ($TaskName -eq 'PunkDuck Backup Manager') { return '' }
    if ($TaskName -cmatch '^PunkDuck Backup Manager \(([A-Za-z0-9_-]{1,32})\)\z') { return $Matches[1] }
    return $null
}

function Remove-BackupTask([string]$Name) {
    $task = Get-ScheduledTask -TaskPath '\' -TaskName $Name -ErrorAction SilentlyContinue
    if (-not $task) { return $false }
    if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskPath '\' -TaskName $Name }
    Unregister-ScheduledTask -TaskPath '\' -TaskName $Name -Confirm:$false
    Write-Host "Removed scheduled task '$Name'."
    return $true
}

# Revoke the Google sign-in of the data folder $Dir (needs the program files).
function Revoke-GoogleSignIn([string]$Dir, [string[]]$HomeArgs) {
    if (-not (Test-Path (Join-Path $Dir 'token.json'))) { return }
    if (-not (Test-Path $Launcher)) {
        Write-Host 'Program files not found; the Google sign-in could not be revoked here.' -ForegroundColor Yellow
        Write-Host 'Revoke it at https://myaccount.google.com/permissions if needed.' -ForegroundColor Yellow
        return
    }
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Launcher @HomeArgs auth logout | Out-Host; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $saved }
    if ($code -ne 0) {
        Write-Host 'The Google sign-in could NOT be revoked (see above); the local copy is deleted anyway.' -ForegroundColor Yellow
        Write-Host 'Have the client remove access at https://myaccount.google.com/permissions.' -ForegroundColor Yellow
    }
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'Run PowerShell as Administrator and start the uninstaller again.' -ForegroundColor Red
    exit 1
}
if ($PSBoundParameters.ContainsKey('Client') -and -not (Test-ClientName $Client)) {
    Write-Host "Invalid -Client '$Client': use the name given to install.ps1 -Client (letters, digits, - and _)." -ForegroundColor Red
    exit 1
}

Push-Location $env:SystemRoot   # we are about to delete the folder this script may live in
try {
    if ($Client) {
        # ---- One client: its task and (with -Purge) its data folder. Program files stay. ----
        $taskName = "PunkDuck Backup Manager ($Client)"
        $dataDir = Join-Path $ClientsDir $Client
        $hadTask = Remove-BackupTask $taskName
        if (-not $hadTask -and -not (Test-Path $dataDir)) {
            Write-Host "Nothing is installed for client '$Client' (no task '$taskName', no folder $dataDir)." -ForegroundColor Yellow
            exit 1
        }
        if ($Purge) {
            if (Test-Path $dataDir) {
                Revoke-GoogleSignIn $dataDir @('--home', $dataDir)
                Remove-Item -Recurse -Force $dataDir
                Write-Host "Removed $dataDir (settings, encryption key, sign-in, logs of client $Client)."
            }
            if ((Test-Path $ClientsDir) -and -not (Get-ChildItem -Force -Path $ClientsDir | Select-Object -First 1)) {
                Remove-Item -Force $ClientsDir
            }
        } elseif (Test-Path $dataDir) {
            Write-Host "Kept $dataDir (settings, encryption key, Google sign-in, logs). Use -Purge to delete it."
        }
        Write-Host "Kept $InstallDir (the program files are shared with the other installs on this machine)."
        Write-Host "The SQL login of client $Client (SQL_USER) was not dropped; drop it in SSMS if it is no longer needed."
    } else {
        # ---- Default install and the shared program files: only when no client has a task left. ----
        # -ErrorAction Stop: if Task Scheduler cannot be queried, stop instead of removing files clients still use.
        $clients = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskPath -eq '\' } |
            ForEach-Object { Get-ClientFromTaskName $_.TaskName } | Where-Object { $_ })
        if ($clients.Count) {
            Write-Host 'These clients are still installed on this machine and use the program files:' -ForegroundColor Red
            foreach ($c in $clients) { Write-Host "  $c   (task 'PunkDuck Backup Manager ($c)')" -ForegroundColor Red }
            Write-Host 'Nothing was changed. Uninstall each client first, then run this again:' -ForegroundColor Yellow
            Write-Host "  powershell -ExecutionPolicy Bypass -File `"$InstallDir\uninstall.ps1`" -Client <name> [-Purge]" -ForegroundColor Yellow
            exit 1
        }

        $dataDir = Join-Path $env:ProgramData $AppName
        [void](Remove-BackupTask 'PunkDuck Backup Manager')
        if ($Purge -and (Test-Path $dataDir)) { Revoke-GoogleSignIn $dataDir @() }

        if (Test-Path $InstallDir) {
            Remove-Item -Recurse -Force $InstallDir
            Write-Host "Removed $InstallDir."
        }

        if ($Purge) {
            if (Test-Path $dataDir) {
                Remove-Item -Recurse -Force $dataDir
                Write-Host "Removed $dataDir (settings, encryption key, sign-in, logs)."
            }
        } else {
            Write-Host "Kept $dataDir (settings, encryption key, Google sign-in, logs). Use -Purge to delete it."
        }
        if (Test-Path $ClientsDir) {
            $kept = @(Get-ChildItem -Directory -Path $ClientsDir | ForEach-Object { $_.Name })
            if ($kept.Count) {
                Write-Host "Kept the data folders of clients without a scheduled task (uninstalled or restore-only) in $ClientsDir`: $($kept -join ', ')." -ForegroundColor Yellow
                Write-Host '  Delete them by hand if they are no longer needed; revoke their Google sign-ins at' -ForegroundColor Yellow
                Write-Host '  https://myaccount.google.com/permissions (the encryption keys are in the password manager).' -ForegroundColor Yellow
            }
        }
    }
    Write-Host 'Backups on Google Drive were not touched.' -ForegroundColor Green
} finally {
    Pop-Location
}
