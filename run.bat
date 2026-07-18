@echo off
setlocal
cd /d "%~dp0"
title Fanad

rem ---- Node.js present? ----
where node >nul 2>nul
if errorlevel 1 (
    echo Node.js was not found. Install Node.js 24 or newer from https://nodejs.org/
    pause
    exit /b 1
)

rem ---- Node.js new enough? (package.json engines: >=24) ----
set "NODE_VER="
for /f "delims=" %%v in ('node -v') do set "NODE_VER=%%v"
set "NODE_VER=%NODE_VER:v=%"
for /f "tokens=1 delims=." %%m in ("%NODE_VER%") do set "NODE_MAJOR=%%m"
if %NODE_MAJOR% LSS 24 (
    echo Fanad needs Node.js 24 or newer; you have %NODE_VER%.
    echo Update from https://nodejs.org/ and run run.bat again.
    pause
    exit /b 1
)

rem ---- Configured yet? ----
if not exist ".env" (
    echo No .env file found - run installer.bat first to set Fanad up.
    pause
    exit /b 1
)

rem ---- Dependencies installed? (express is a direct dep; its absence means npm install never ran) ----
if not exist "node_modules\express\package.json" (
    where npm >nul 2>nul
    if errorlevel 1 (
        echo npm was not found. Reinstall Node.js from https://nodejs.org/ and try again.
        pause
        exit /b 1
    )
    echo First run: installing dependencies ^(this can take a few minutes^)...
    call npm install
    if errorlevel 1 (
        echo.
        echo npm install failed - see the errors above.
        pause
        exit /b 1
    )
)

rem ---- Web UI built? ----
if not exist "web\dist\index.html" (
    echo Building the web UI...
    call npm run build
    if errorlevel 1 (
        echo.
        echo The web build failed - see the errors above.
        pause
        exit /b 1
    )
)

rem ---- Read the port from .env so the printed URL is right (default 8787) ----
set "PORT=8787"
for /f "tokens=1* delims==" %%a in ('findstr /b /c:"PORT=" .env') do set "PORT=%%b"
if "%PORT%"=="" set "PORT=8787"

echo.
echo Starting Fanad on http://localhost:%PORT%  ^(Ctrl+C to stop^)
echo.
node --env-file-if-exists=.env server\index.js
if errorlevel 1 (
    echo.
    echo Fanad stopped with an error - see above.
    pause
    exit /b 1
)
exit /b 0
