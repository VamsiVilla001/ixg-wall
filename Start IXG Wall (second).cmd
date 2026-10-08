@echo off
rem A second IXG Wall beside the first, for running two sessions at once: its own port
rem (8081) and its own data folder (%LOCALAPPDATA%\IXG Wall 2), so the two never share or
rem overwrite each other's feeds. Its wall window gets its own browser profile too.
rem It keeps its own settings: paste the YouTube API key (and Slack, channel sign-ins) in
rem this wall's Settings once; they aren't copied from the first wall. The same local.env
rem (password) applies to both. Needs Node 22.9 or newer.
cd /d "%~dp0"
title IXG Wall backend (second, port 8081)
set PORT=8081
set "IXG_DATA_DIR=%LOCALAPPDATA%\IXG Wall 2"
node --env-file-if-exists=local.env server.js --open
pause
