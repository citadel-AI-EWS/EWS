@echo off
setlocal
title CITADEL EWS Core Service Installer
echo [CITADEL] Core Service mode requires one Windows administrator approval.
echo [CITADEL] It uses the bundled Python runtime; no Python/winget/pip installation is performed.
powershell.exe -NoLogo -NoProfile -File "%~dp0setup_windows.ps1" %*
exit /b %ERRORLEVEL%
