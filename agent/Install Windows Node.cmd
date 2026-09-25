@echo off
setlocal
title CITADEL EWS Local Agent Installer
set "ARCH=%PROCESSOR_ARCHITECTURE%"
if /I "%PROCESSOR_ARCHITEW6432%"=="AMD64" set "ARCH=AMD64"
if /I "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "ARCH=ARM64"
if /I "%ARCH%"=="AMD64" set "PY=%~dp0python-runtime-amd64\python.exe"
if /I "%ARCH%"=="X86" set "PY=%~dp0python-runtime-win32\python.exe"
if /I "%ARCH%"=="ARM64" set "PY=%~dp0python-runtime-arm64\python.exe"
if not defined PY (
  echo Unsupported Windows architecture: %ARCH%
  pause
  exit /b 1
)
if not exist "%PY%" (
  echo Bundled Python runtime is missing: %PY%
  pause
  exit /b 1
)
"%PY%" "%~dp0setup_windows_local.py" %*
if errorlevel 1 (
  echo.
  echo Local Agent installation or repair failed. See the message above.
  pause
  exit /b 1
)
echo.
echo CITADEL Local Agent installation/repair completed successfully.
pause
exit /b 0
