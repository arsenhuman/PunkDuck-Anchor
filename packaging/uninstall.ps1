<#
.SYNOPSIS
    Uninstall PunkDuck backup-manager.

.DESCRIPTION
    Removes the scheduled task and C:\Program Files\backup-manager.
    Keeps C:\ProgramData\backup-manager (settings, encryption key, Google sign-in, logs) unless -Purge is given.
    Backups on Google Drive are NEVER touched.

.PARAMETER Purge
    Also revoke the Google sign-in and delete C:\ProgramData\backup-manager.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File "C:\Program Files\backup-manager\uninstall.ps1"

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File "C:\Program Files\backup-manager\uninstall.ps1" -Purge
#>
[CmdletBinding()]
param(
    [switch]$Purge
)

# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads BOM-less scripts as ANSI.

$ErrorActionPreference = 'Stop'

$AppName    = 'backup-manager'
$TaskName   = 'PunkDuck Backup Manager'
$InstallDir = Join-Path $env:ProgramFiles $AppName
$DataDir    = Join-Path $env:ProgramData $AppName
$Launcher   = Join-Path $InstallDir "$AppName.cmd"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'Run PowerShell as Administrator and start the uninstaller again.' -ForegroundColor Red
    exit 1
}

Push-Location $env:SystemRoot   # we are about to delete the folder this script may live in
try {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName }
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed scheduled task '$TaskName'."
    }

    if ($Purge) {
        if (Test-Path $Launcher) {
            $saved = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            try { & $Launcher auth logout | Out-Host; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $saved }
            if ($code -ne 0) {
                Write-Host 'The Google sign-in could NOT be revoked (see above); the local copy is deleted anyway.' -ForegroundColor Yellow
                Write-Host 'Have the client remove access at https://myaccount.google.com/permissions.' -ForegroundColor Yellow
            }
        } else {
            Write-Host 'Program files not found; the Google sign-in could not be revoked here.' -ForegroundColor Yellow
            Write-Host 'Revoke it at https://myaccount.google.com/permissions if needed.' -ForegroundColor Yellow
        }
    }

    if (Test-Path $InstallDir) {
        Remove-Item -Recurse -Force $InstallDir
        Write-Host "Removed $InstallDir."
    }

    if ($Purge) {
        if (Test-Path $DataDir) {
            Remove-Item -Recurse -Force $DataDir
            Write-Host "Removed $DataDir (settings, encryption key, sign-in, logs)."
        }
    } else {
        Write-Host "Kept $DataDir (settings, encryption key, Google sign-in, logs). Use -Purge to delete it."
    }
    Write-Host 'Backups on Google Drive were not touched.' -ForegroundColor Green
} finally {
    Pop-Location
}
