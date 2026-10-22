@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 18+ from https://nodejs.org/
  pause
  exit /b 1
)
echo.
echo Before harvesting:
echo   1. Log into WeChat on this PC.
echo   2. Open each target mini-program once.
echo   3. Keep WeChat running.
echo.
node "tools\harvest.js" %*
set CODE=%errorlevel%
echo.
if not "%CODE%"=="0" echo Harvest failed. Read the messages above.
if "%CODE%"=="0" echo Done. Run doctor.bat to verify.
pause
exit /b %CODE%
