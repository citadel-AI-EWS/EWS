@echo off
setlocal EnableExtensions
title CITADEL EWS Node Installer
set "ROOT=%~dp0"
set "RUNTIME=%ROOT%python_runtime\amd64\python.exe"
if /I "%PROCESSOR_ARCHITECTURE%"=="x86" if "%PROCESSOR_ARCHITEW6432%"=="" set "RUNTIME=%ROOT%python_runtime\win32\python.exe"
if not exist "%RUNTIME%" (
  echo [CITADEL] Bundled Python runtime is missing.
  exit /b 2
)
"%RUNTIME%" "%ROOT%windows_bootstrap.py" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" echo [CITADEL] Installation failed with code %RC%.
exit /b %RC%
