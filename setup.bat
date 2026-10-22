@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found.
  echo Install Node.js 18+ from https://nodejs.org/ and run setup.bat again.
  pause
  exit /b 1
)
node "tools\setup.js"
set CODE=%errorlevel%
echo.
pause
exit /b %CODE%
