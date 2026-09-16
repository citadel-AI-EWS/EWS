@echo off
setlocal
title CITADEL EWS Node Installer
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_windows.ps1" %*
if errorlevel 1 (
  echo.
  echo Installation or repair failed. See the message above.
  pause
  exit /b 1
)
echo.
echo CITADEL installation/repair completed successfully.
pause
exit /b 0
