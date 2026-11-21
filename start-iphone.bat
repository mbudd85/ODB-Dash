@echo off
REM Serve your iPhone: HTTPS + reachable over WiFi. Join the Veepeak WiFi first.
cd /d "%~dp0"
python server.py --iphone %*
pause
