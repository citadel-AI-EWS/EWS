@echo off
setlocal
title CITADEL EWS Portable Fallback
if not exist "%~dp0runtime\python.exe" (
  echo CITADEL portable package is incomplete: runtime\python.exe is missing.
  pause
  exit /b 1
)
if not exist "%~dp0portable_fallback.py" (
  echo CITADEL portable package is incomplete: portable_fallback.py is missing.
  pause
  exit /b 1
)
set "PYTHONHOME=%~dp0runtime"
"%~dp0runtime\python.exe" "%~dp0portable_fallback.py" install --source "%~dp0." %*
if errorlevel 1 (
  echo.
  echo Portable fallback installation failed.
  pause
  exit /b 1
)
echo.
echo CITADEL portable fallback is installed.
echo The node will appear in the Hub when the Controller becomes reachable.
pause
exit /b 0
