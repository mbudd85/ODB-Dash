@echo off
cd /d "%~dp0"
REM Prefer the Python launcher (newest installed Python), fall back to "python".
where py >nul 2>nul
if %errorlevel%==0 (py -3 server.py %*) else (python server.py %*)
pause
