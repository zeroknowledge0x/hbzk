@echo off
REM Hubie Live - Windows supervisor loop (single-instance).
REM Node restarts dead children; this loop restarts Node if the process dies.
setlocal
cd /d "%~dp0"

REM Mutex via lock file (PID). Stale lock cleared if PID dead.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\hubie-single-instance.ps1" -Mode claim
if errorlevel 1 (
  echo [hubie] another Hubie supervisor already owns the lock - exit
  exit /b 2
)

if not exist node_modules (
  echo [hubie] installing dependencies
  call npm install
)

node scripts\bootstrap.mjs --check
if errorlevel 1 (
  echo [hubie] vendored binaries missing, downloading
  call node scripts\bootstrap.mjs
)

:loop
REM Re-claim / refuse if another node snuck in
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\hubie-single-instance.ps1" -Mode recheck
if errorlevel 1 (
  echo [hubie] another Hubie node detected before restart - exit
  exit /b 2
)
REM A safety halt is a stop, not a crash: never restart into the same unresolved hand.
REM A human start (HUBIE_HUMAN_START=1) is what clears the marker.
if not "%HUBIE_HUMAN_START%"=="1" (
  node scripts\safety-halt-check.mjs
  if errorlevel 1 (
    echo [hubie] safety halt on record - live stays off until the cause is fixed
    exit /b 3
  )
)
echo [hubie] starting %DATE% %TIME%
node src\index.js
echo [hubie] process exited, restarting in 5 seconds
timeout /t 5 /nobreak >nul
goto loop
