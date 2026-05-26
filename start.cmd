@echo off
REM v0.3.6.
cd /d "%~dp0"
set ELECTRON_DISABLE_SANDBOX=1
npm start
