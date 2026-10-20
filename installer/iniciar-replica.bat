@echo off
rem ==========================================================================
rem iniciar-replica.bat (lo copia el instalador a la carpeta de la app)
rem --------------------------------------------------------------------------
rem Bucle de la replica de solo lectura:
rem   1. node scripts\replica-sync.js: trae el ultimo snapshot del repo de
rem      datos y lo aplica (base, fotos, config). Sin red, sigue con lo que
rem      ya tenia.
rem   2. node server.js: sirve la app en http://localhost:<PORT>.
rem      Cuando el sondeo ve un snapshot nuevo, sale con codigo 75 y el bucle
rem      vuelve a sincronizar enseguida. Con cualquier otro codigo (una
rem      caida), espera 10 s.
rem
rem Usa el Node y el MinGit portables de esta carpeta. La salida va a
rem logs\replica.<fecha>_<hora>.log, un archivo por arranque del bucle.
rem Para parar: cerrar esta ventana.
rem ==========================================================================
setlocal
title Social Listening (copia de solo lectura)
cd /d "%~dp0"
set "PATH=%~dp0node;%PATH%"
set "REPLICA_GIT=%~dp0mingit\cmd\git.exe"
if not exist logs mkdir logs

for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HHmm"`) do set "STAMP=%%i"
set "LOG=logs\replica.%STAMP%.log"
echo Social Listening, copia de solo lectura. Log: %LOG%
echo Para pararla, cerrar esta ventana.

:loop
echo [%time%] Buscando datos nuevos...
node scripts\replica-sync.js >> "%LOG%" 2>&1
echo [%time%] Arrancando la app.
node server.js >> "%LOG%" 2>&1
set "CODIGO=%errorlevel%"
if "%CODIGO%"=="75" (
  echo [%time%] Hay datos nuevos: actualizando.
  goto loop
)
echo [%time%] La app termino con codigo %CODIGO%. Reinicio en 10 s...
timeout /t 10 /nobreak >nul
goto loop
