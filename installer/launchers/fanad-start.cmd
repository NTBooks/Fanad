@echo off
setlocal
cd /d "%~dp0.."
title Fanad

rem Installed-layout launcher (see installer\fanad.iss): everything is bundled, so unlike run.bat
rem there is nothing to check or install here — runtime\node.exe is the private pinned Node.

rem ---- First run: no .env yet -> run the setup wizard before starting the server. ----
if not exist ".env" (
    echo  First run - starting the setup wizard... your browser will open in a moment.
    echo  ^(If it does not, copy the address printed below into your browser.^)
    echo.
    "runtime\node.exe" server\scripts\setup-server.js
    if errorlevel 1 (
        echo.
        echo  Setup did not complete. Fix the error above, or run "Fanad Setup" to try again.
        pause
        exit /b 1
    )
)

rem ---- Read the port from .env so the printed URL is right (default 8787) ----
set "PORT=8787"
for /f "tokens=1* delims==" %%a in ('findstr /b /c:"PORT=" .env') do set "PORT=%%b"
if "%PORT%"=="" set "PORT=8787"

echo.
echo Starting Fanad on http://localhost:%PORT%  ^(close this window or Ctrl+C to stop^)
echo.
"runtime\node.exe" --env-file-if-exists=.env server\index.js
if errorlevel 1 (
    echo.
    echo Fanad stopped with an error - see above.
    pause
    exit /b 1
)
exit /b 0
