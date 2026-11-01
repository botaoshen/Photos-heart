@echo off
rem Starts the photo app and opens it in the browser. Close this window to stop.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Please install it from https://nodejs.org and try again.
  pause
  exit /b 1
)
node server.js
if errorlevel 1 pause
