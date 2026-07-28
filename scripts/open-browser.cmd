@echo off
rem Wartet kurz, bis der lokale Server lauscht, und oeffnet dann den Standardbrowser.
setlocal
set "URL=%~1"
if "%URL%"=="" set "URL=http://127.0.0.1:3000/"
timeout /t 3 /nobreak >nul 2>&1
start "" "%URL%"
endlocal
