@echo off
cd /d "%~dp0"
REM Adapter speed test: stops OBD Dash, times read-only requests, saves speedtest.txt, restarts OBD Dash.
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -match ^(py|python)[0-9.]*w?\.exe$ -and $_.CommandLine -match server\.py } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>nul
echo Testing the adapter, about 30 seconds...
py -3.11 tools\bench.py > speedtest.txt 2>&1 || py -3 tools\bench.py > speedtest.txt 2>&1
type speedtest.txt
echo.
echo Saved to speedtest.txt. Starting OBD Dash again...
start "" "%~dp0start.bat"
pause
