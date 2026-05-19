@echo off
cd /d "%~dp0"
set ELECTRON_DISABLE_SANDBOX=1
npx electron .
