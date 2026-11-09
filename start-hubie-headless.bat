@echo off
REM Run from this checkout, not a hard-coded path: the launcher must start the code it ships in.
cd /d "%~dp0"
set HUBIE_HEADED=0
REM A launcher a person runs is a human touch: it restarts the unattended clock.
set HUBIE_HUMAN_START=1
set PATH=C:\Program Files\nodejs;%PATH%
call run-hubie.bat
