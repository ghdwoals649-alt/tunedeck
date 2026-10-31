@echo off
setlocal
cd /d "%~dp0"
title TuneDeck build

echo.
echo ==============================================
echo   TuneDeck build
echo ==============================================

rem --- Running from inside the zip? (Windows opens zips in a temp folder)
echo %~dp0 | findstr /i "\\Temp\\" > nul
if not errorlevel 1 goto inzip

if not exist "%~dp0build.ps1" goto missing

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1"
echo.
pause
exit /b

:inzip
echo.
echo [!] You are running this from inside the zip file.
echo     Right-click the zip, choose "Extract All", then run build.bat
echo     from the extracted folder.
pause
exit /b 1

:missing
echo.
echo [!] build.ps1 is missing. Extract the whole zip again.
pause
exit /b 1
