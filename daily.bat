@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 18+ from https://nodejs.org/
  exit /b 1
)
node "src\run-daily.js" %*
exit /b %errorlevel%
