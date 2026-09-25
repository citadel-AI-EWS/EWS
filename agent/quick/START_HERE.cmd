@echo off
setlocal
cd /d "%~dp0"
title CITADEL EWS Quick Agent 0.3.16

set "PY=%~dp0runtime\python.exe"
if not exist "%PY%" (
  echo [CITADEL] Bundled Python runtime is missing.
  echo [CITADEL] Re-extract the complete CITADEL Quick Agent package and try again.
  pause
  exit /b 2
)

echo [CITADEL] Starting one-click user-mode installation...
"%PY%" "%~dp0quick_install.py"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo [CITADEL] Installation failed with code %RC%.
  echo [CITADEL] No administrator approval or PowerShell policy change was attempted.
  pause
)
exit /b %RC%
