@echo off
setlocal
title Remove CITADEL EWS Portable Fallback
if not exist "%~dp0runtime\python.exe" (
  echo CITADEL portable package is incomplete: runtime\python.exe is missing.
  pause
  exit /b 1
)
set "PYTHONHOME=%~dp0runtime"
"%~dp0runtime\python.exe" "%~dp0portable_fallback.py" uninstall %*
if errorlevel 1 (
  echo.
  echo Portable fallback removal failed.
  pause
  exit /b 1
)
echo.
echo Portable CITADEL fallback removed. Node identity was preserved by default.
pause
exit /b 0
