@echo off
setlocal
cd /d "%~dp0.."
title Fanad setup

echo.
echo  Fanad setup
echo  ===========
echo.

rem The wizard guards itself: if .env already exists it prints a notice and exits 0,
rem and the .env write uses the 'wx' flag so nothing is ever overwritten.
echo  Starting the setup wizard... your browser will open in a moment.
echo  ^(If it does not, copy the address printed below into your browser.^)
echo.

"runtime\node.exe" server\scripts\setup-server.js
if errorlevel 1 (
    echo.
    echo  Setup did not complete. Fix the error above and try again.
    pause
    exit /b 1
)

echo.
echo  Done. Start Fanad with the "Start Fanad Server" shortcut.
echo.
pause
exit /b 0
