@echo off
rem Starts the IXG Wall backend and opens the managed wall window.
rem Keep this window open while the wall runs; closing it stops telemetry (feeds keep playing).
cd /d "%~dp0"
title IXG Wall backend
node server.js --open
pause
