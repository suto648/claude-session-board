@echo off
rem ============================================================
rem  ASCII ONLY -- do not put Japanese in this file.
rem
rem  cmd.exe reads .cmd using the system code page (CP932 on a
rem  Japanese Windows), so UTF-8 Japanese is mis-parsed outright.
rem  Japanese belongs in node's own output (we switch the console
rem  to 65001 first) and in the .txt files next to this one.
rem ============================================================

rem ---- Find the app --------------------------------------------
rem  Shipped layout : this file at the top, code under "app\".
rem  Source checkout: this file sits next to server.js.
if exist "%~dp0app\server.js" (
    set "APPDIR=%~dp0app"
) else (
    set "APPDIR=%~dp0"
)
cd /d "%APPDIR%"

rem ---- Locate node (prefer the bundled one) ----------------------
set "NODE_CMD=node"
if exist "%APPDIR%\node\node.exe" (
    set "NODE_CMD=%APPDIR%\node\node.exe"
)

"%NODE_CMD%" --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo   [ERROR] Node.js was not found.
    echo.
    echo   This package ships with Node.js inside "app\node".
    echo   If you copied only some files out of the zip, extract the
    echo   whole folder again and run this file from there.
    echo.
    pause
    exit /b 1
)

rem  Switch the console to UTF-8 so node's own output is readable.
rem  Everything below this line must stay ASCII.
chcp 65001 >nul 2>&1
"%NODE_CMD%" server.js
if errorlevel 1 (
    echo.
    echo   Please read the message above.
    echo.
    pause
)
