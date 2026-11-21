@echo off
cd /d "%~dp0"
python server.py --iphone --sim %*
pause
