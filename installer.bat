@echo off
setlocal
cd /d "%~dp0"
title Fanad installer

echo.
echo  Fanad first-run setup
echo  =====================
echo.

rem -- Node.js is the only requirement; the wizard itself has zero npm dependencies. --
where node >nul 2>nul
if errorlevel 1 (
    echo  Node.js was not found on this computer.
    echo.
    echo  Install Node.js 24 or newer from:  https://nodejs.org/
    echo  Then run installer.bat again.
    echo.
    pause
    exit /b 1
)

rem -- One-shot guard: if setup already produced a .env, refuse rather than overwrite. --
if exist ".env" (
    echo  The installer has already run: a .env file exists in this folder.
    echo.
    echo  To change settings:  edit .env directly ^(see .env.example for every option^)
    echo  To start over:       delete the .env file, then run installer.bat again
    echo.
    pause
    exit /b 0
)

echo  Starting the setup wizard... your browser will open in a moment.
echo  ^(If it does not, copy the address printed below into your browser.^)
echo.

node server\scripts\setup-server.js
if errorlevel 1 (
    echo.
    echo  Setup did not complete. Fix the error above and run installer.bat again.
    echo.
    pause
    exit /b 1
)

echo.
echo  All set! Use run.bat to start Fanad.
echo.
pause
exit /b 0
