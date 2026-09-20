@echo off
rem Starts VR Macro Pad. Installs its dependencies the first time.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo First run: installing dependencies, this takes a minute...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo Install failed. See the messages above.
    pause
    exit /b 1
  )
)

rem Launch without keeping a console window open.
start "" "node_modules\electron\dist\electron.exe" "%~dp0."
