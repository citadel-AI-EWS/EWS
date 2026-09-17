@echo off
setlocal
title CITADEL EWS Node Installer
powershell.exe -NoLogo -NoProfile -File "%~dp0setup_windows.ps1" %*
if errorlevel 1 (
  echo.
  echo Installation or repair failed. See the message above.
  echo If Windows blocks local PowerShell scripts, use your organization's approved execution policy instead of bypassing it.
  pause
  exit /b 1
)
echo.
echo CITADEL installation/repair completed successfully.
pause
exit /b 0
