@echo off
setlocal
cd /d "%~dp0"
set "PY=%~dp0runtime\python.exe"
if not exist "%PY%" (
  echo [CITADEL] Bundled Python runtime is missing.
  pause
  exit /b 2
)
"%PY%" "%~dp0quick_install.py" --uninstall
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" pause
exit /b %RC%
