@echo off
setlocal
title CITADEL EWS Node Installer
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_windows.ps1"
if errorlevel 1 (
  echo.
  echo Installation failed. See the message above.
  pause
  exit /b 1
)
echo.
echo Installation completed successfully. This window can be closed.
pause
exit /b 0
