@echo off
setlocal
title CITADEL EWS Windows Service Installer
echo This mode installs the machine service and requires Administrator approval.
powershell.exe -NoLogo -NoProfile -File "%~dp0setup_windows.ps1" %*
if errorlevel 1 (
  echo.
  echo Windows Service installation or repair failed. See the message above.
  pause
  exit /b 1
)
echo.
echo CITADEL Windows Service installation/repair completed successfully.
pause
exit /b 0
