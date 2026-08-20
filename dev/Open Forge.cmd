@echo off
setlocal
title Forge Local Server
cd /d "%~dp0"

where node.exe >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found on this computer.
  echo Please install Node.js, then run this file again.
  echo.
  pause
  exit /b 1
)

echo Starting Forge...
echo Keep this window open while using Forge.
echo Close this window to stop the local server.
echo.

node.exe "%~dp0forge-local-server.mjs"

if errorlevel 1 (
  echo.
  echo Forge could not start. Please copy the message above for troubleshooting.
  pause
)

