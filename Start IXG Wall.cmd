@echo off
rem Starts the IXG Wall backend and opens the managed wall window.
rem Keep this window open while the wall runs; closing it stops telemetry (feeds keep playing).
rem This computer's own settings, such as the wall password, go in local.env beside this
rem file (copy local.env.example; it is never committed). Needs Node 22.9 or newer.
cd /d "%~dp0"
title IXG Wall backend
node --env-file-if-exists=local.env server.js --open
pause
