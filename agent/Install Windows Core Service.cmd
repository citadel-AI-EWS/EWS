@echo off
setlocal EnableExtensions
title CITADEL EWS Core Service Installer
echo [CITADEL] Core Service mode requires one Windows administrator approval.
echo [CITADEL] It uses the bundled Python runtime; no Python/winget/pip installation is performed.
powershell.exe -NoLogo -NoProfile -File "%~dp0setup_windows.ps1" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo [CITADEL] Core Service installation failed with code %RC%.
  echo [CITADEL] If Windows blocked scripts from the extracted package, unblock the package files
  echo [CITADEL] or use your organization's approved signed setup script. Do not bypass policy.
  exit /b %RC%
)
exit /b 0
