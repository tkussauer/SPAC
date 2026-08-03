@echo off
rem ===========================================================================
rem  PDF-Vergleichstool - Start per Doppelklick (FR8 / NFR4)
rem  Startet den lokalen Server und oeffnet die Anwendung im Standardbrowser.
rem
rem  Ohne Installationsrechte: Node.js als ZIP (node-vXX-win-x64.zip) von
rem  nodejs.org herunterladen und den Inhalt in den Unterordner "node\"
rem  entpacken, sodass "node\node.exe" existiert. Diese Datei findet es dort
rem  von selbst - eine Installation ist dann nicht noetig.
rem ===========================================================================
setlocal
cd /d "%~dp0"
title PDF-Vergleichstool

if "%SPAC_PORT%"=="" set "SPAC_PORT=3000"
if "%SPAC_HOST%"=="" set "SPAC_HOST=127.0.0.1"
set "APP_URL=http://%SPAC_HOST%:%SPAC_PORT%/"

rem Mitgeliefertes (portables) Node.js hat Vorrang vor einer Installation.
if exist "%~dp0node\node.exe" (
  set "PATH=%~dp0node;%~dp0node\bin;%PATH%"
  echo.
  echo   Mitgeliefertes Node.js wird verwendet ^(Ordner "node"^).
)

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   FEHLER: Node.js wurde nicht gefunden.
  echo.
  echo   Entweder Node.js 20 oder neuer installieren: https://nodejs.org/
  echo   Oder - ohne Installationsrechte - dort "Windows Binary (.zip)"
  echo   herunterladen und den Inhalt in den Unterordner "node" entpacken,
  echo   sodass "%~dp0node\node.exe" existiert. Danach diese Datei erneut starten.
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
    echo   Ohne Zugang zur npm-Registry hilft ein Paket, in dem der Ordner
    echo   "node_modules" bereits enthalten ist.
    pause
    exit /b 1
  )
)

rem Das Frontend wird nur gebaut, wenn es fehlt oder gebaut werden kann.
rem In einem fertigen Paket liegt "public" bereits vor - dann ist esbuild
rem nicht noetig und der Schritt entfaellt.
if not exist "public\main.js" (
  echo.
  echo   Frontend wird gebaut ...
  call npm run build
  if errorlevel 1 (
    echo   FEHLER: "npm run build" ist fehlgeschlagen.
    pause
    exit /b 1
  )
) else (
  if exist "node_modules\esbuild\" (
    echo.
    echo   Frontend wird gebaut ...
    call npm run build
  )
)

echo.
echo   Server startet unter %APP_URL%
echo   Der Browser oeffnet sich gleich automatisch.
echo   Fehlerprotokoll (inkl. gesendetem Body): %~dp0logs\spac.log
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
