@echo off
rem ==========================================================================
rem scripts\iniciar-con-reinicio.bat
rem --------------------------------------------------------------------------
rem Arranca la app (node server.js) y, si el proceso muere por lo que sea
rem (un error no atrapado, un corte), la vuelve a levantar sola a los 10 s.
rem Pensado para dejarla corriendo varios dias sin nadie mirando.
rem
rem   - La salida (consola y errores) va a logs\server.<fecha>_<hora>.log,
rem     un archivo por arranque; en esta ventana solo se ven los arranques y
rem     las caidas. Con la salida en un archivo, un clic adentro de la
rem     ventana (modo QuickEdit) ya no puede congelar el proceso.
rem   - Ademas apaga QuickEdit en ESTA consola (scripts\quickedit-off.ps1),
rem     por si igual queda algo escribiendo en pantalla.
rem   - Ctrl+C corta el bucle (cmd pregunta "Terminar trabajo por lotes").
rem     OJO: "npm run stop" mata el node pero este bucle lo vuelve a
rem     levantar; para parar de verdad, Ctrl+C aca o cerrar la ventana.
rem
rem Lo que este script NO puede evitar: que la PC se suspenda. Antes de
rem dejarla sola, en una consola: powercfg /change standby-timeout-ac 0
rem (ver README, "Dejarla corriendo sola varios dias").
rem ==========================================================================
setlocal
title Social Listening (reinicio automatico)
cd /d "%~dp0.."
if not exist logs mkdir logs

powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\quickedit-off.ps1"

:loop
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HHmm"`) do set "STAMP=%%i"
set "LOG=logs\server.%STAMP%.log"
echo [%STAMP%] Arrancando node server.js (log: %LOG%). Ctrl+C para cortar.
node server.js >> "%LOG%" 2>&1
set "CODIGO=%errorlevel%"
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HHmm"`) do set "STAMP=%%i"
echo [%STAMP%] El proceso termino con codigo %CODIGO%. Reinicio en 10 s (Ctrl+C para cortar)...
timeout /t 10 /nobreak >nul
goto loop
