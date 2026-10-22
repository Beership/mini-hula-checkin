@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\doctor.ps1"
set CODE=%errorlevel%
echo.
pause
exit /b %CODE%
