@echo off
setlocal
cd /d "%~dp0"
REM Use whichever installed Python already has aiohttp; if none does, install it.
set "PY="
for %%P in ("py -3.11" "py -3" "python") do (
  if not defined PY (
    %%~P -c "import aiohttp" >nul 2>nul && set "PY=%%~P"
  )
)
if not defined PY (
  echo aiohttp is missing - installing it once...
  py -3 -m pip install --user aiohttp && py -3 -c "import aiohttp" >nul 2>nul && set "PY=py -3"
)
if not defined PY (
  python -m pip install --user aiohttp && python -c "import aiohttp" >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo Could not find or set up Python. Install Python 3 from python.org, then run: py -3 -m pip install aiohttp
  pause
  exit /b 1
)
echo Starting OBD Dash with %PY% ...
%PY% server.py %*
pause
