@echo off
rem Launcher for backup-manager using the bundled Node.js runtime.
setlocal
"%~dp0node.exe" "%~dp0bin\backup-manager.js" %*
exit /b %ERRORLEVEL%
