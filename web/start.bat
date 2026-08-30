@echo off
echo ====== Warhorn Borderline WEB Launcher ======
echo.

:: cd to this batch's own directory (web/). %~dp0 is resolved by cmd from the
:: real path, so the Chinese folder name never goes through code-page decoding
:: (unlike a hardcoded Chinese path, which utf-8/GBK mismatch garbles). This
:: avoids the chcp 65001 batch-parsing bug that previously made the server
:: window fail to spawn.
cd /d "%~dp0"

:: Kill any process occupying port 3000 (stale server)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
  echo [cleanup] kill old server PID=%%a
  taskkill /PID %%a /F >nul 2>&1
)

echo [1/2] starting server (http://localhost:3000)
start "Warhorn-Server" /D "%~dp0" cmd /k "npm run dev:server"
timeout /t 2 /nobreak >nul
echo [2/2] starting client (http://localhost:5173)
start "Warhorn-Client" /D "%~dp0" cmd /k "npm run dev:client"
echo.
echo Server: http://localhost:3000
echo Client: http://localhost:5173
echo.
echo Close the two windows to stop the servers.