@echo off
rem ===========================================================================
rem  PDF-Vergleichstool - Diagnose eines PDFs
rem
rem  Zeigt, was die Anwendung in einem PDF sieht: Formularfelder mit Feldwert
rem  und gezeichnetem Wert, Textelemente je Seite und was in den Vergleich
rem  eingeht.
rem
rem  Bedienung: Die PDF-Datei einfach auf diese Datei ziehen (Drag & Drop)
rem             oder diese Datei doppelklicken und den Pfad eingeben.
rem
rem  Das Ergebnis landet zusaetzlich in  diagnose-ausgabe.txt
rem ===========================================================================
setlocal
cd /d "%~dp0"
title PDF-Vergleichstool - Diagnose
chcp 65001 >nul 2>&1

rem Mitgeliefertes (portables) Node.js hat Vorrang vor einer Installation.
if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%~dp0node\bin;%PATH%"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   FEHLER: Node.js wurde nicht gefunden.
  echo   Siehe LIESMICH-ZUERST.txt bzw. docs\INSTALLATION-Windows.md
  echo.
  pause
  exit /b 1
)

set "PDF=%~1"
if "%PDF%"=="" (
  echo.
  echo   Pfad zur PDF-Datei angeben ^(oder die Datei auf diagnose.bat ziehen^):
  set /p "PDF=  > "
)

rem Anfuehrungszeichen entfernen, falls der Pfad aus dem Explorer kopiert wurde.
set "PDF=%PDF:"=%"

if not exist "%PDF%" (
  echo.
  echo   FEHLER: Datei nicht gefunden: %PDF%
  echo.
  pause
  exit /b 1
)

set "AUSGABE=%~dp0diagnose-ausgabe.txt"

echo.
echo   Untersuche: %PDF%
echo.

node "scripts\pdf-diagnose.mjs" "%PDF%" --text > "%AUSGABE%" 2>&1
type "%AUSGABE%"

echo.
echo ===========================================================================
echo   Das Ergebnis steht auch in:
echo   %AUSGABE%
echo   Diese Datei laesst sich verschicken.
echo ===========================================================================
echo.
pause
endlocal
