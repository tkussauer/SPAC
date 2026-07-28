@echo off
rem ===========================================================================
rem  PDF-Vergleichstool - Start per Doppelklick (FR8 / NFR4)
rem  Installiert bei Bedarf die Abhaengigkeiten, baut das Frontend,
rem  startet den lokalen Server und oeffnet die Anwendung im Standardbrowser.
rem ===========================================================================
setlocal
cd /d "%~dp0"
title PDF-Vergleichstool

if "%SPAC_PORT%"=="" set "SPAC_PORT=3000"
if "%SPAC_HOST%"=="" set "SPAC_HOST=127.0.0.1"
set "APP_URL=http://%SPAC_HOST%:%SPAC_PORT%/"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   FEHLER: Node.js wurde nicht gefunden.
  echo   Bitte Node.js 20 oder neuer installieren: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo.
  echo   Erstmalige Einrichtung: Abhaengigkeiten werden installiert ...
  call npm install
  if errorlevel 1 (
    echo   FEHLER: "npm install" ist fehlgeschlagen.
    pause
    exit /b 1
  )
)

echo.
echo   Frontend wird gebaut ...
call npm run build
if errorlevel 1 (
  echo   FEHLER: "npm run build" ist fehlgeschlagen.
  pause
  exit /b 1
)

echo.
echo   Server startet unter %APP_URL%
echo   Der Browser oeffnet sich gleich automatisch.
echo   Zum Beenden dieses Fenster schliessen oder Strg+C druecken.
echo.

rem Browser zeitversetzt oeffnen, damit der Server bereits lauscht.
start "PDF-Vergleichstool oeffnen" /min "%~dp0scripts\open-browser.cmd" "%APP_URL%"

node "src\server\index.js"

if errorlevel 1 (
  echo.
  echo   Der Server wurde mit einem Fehler beendet.
  pause
)
endlocal
