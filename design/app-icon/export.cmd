@echo off
setlocal EnableExtensions
cd /d "%~dp0"
if errorlevel 1 goto :fail_cd

set "EDGE="
if defined ProgramFiles(x86) if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined EDGE if defined ProgramFiles if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined EDGE goto :fail_edge

echo Validating SVG sources...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0validate-svg.ps1"
if errorlevel 1 goto :fail_validation

set "PAGE=file:///%CD:\=/%/render.html"
call :render concept-a.svg concept-a-1200.png 1200 ""
if errorlevel 1 goto :fail_render
call :render concept-b.svg concept-b-1200.png 1200 ""
if errorlevel 1 goto :fail_render
call :render concept-c.svg concept-c-1200.png 1200 ""
if errorlevel 1 goto :fail_render

echo Rendering labelled concept comparison sheet...
"%EDGE%" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --run-all-compositor-stages-before-draw --virtual-time-budget=2500 --window-size=1120,2200 --screenshot="%CD%\compare.png" "file:///%CD:\=/%/compare.html"
if errorlevel 1 goto :fail_compare
node verify-png.js compare.png@1120x2200
if errorlevel 1 goto :fail_compare

echo PASS: all concept exports and comparison image are ready.
exit /b 0

:render
set "SOURCE=%~1"
set "OUTPUT=%~2"
set "SIZE=%~3"
set "QUERY=?src=%SOURCE%&size=%SIZE%"
if not "%~4"=="" set "QUERY=%QUERY%&bg=%~4"
echo Rendering %SOURCE% to %OUTPUT% (%SIZE%x%SIZE%)...
"%EDGE%" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --run-all-compositor-stages-before-draw --virtual-time-budget=1200 --window-size=%SIZE%,%SIZE% --screenshot="%CD%\%OUTPUT%" "%PAGE%%QUERY%"
if errorlevel 1 exit /b 1
node verify-png.js %OUTPUT%@%SIZE%x%SIZE%
if errorlevel 1 exit /b 1
exit /b 0

:fail_cd
echo FAIL: Could not enter the icon asset folder.
exit /b 1
:fail_edge
echo FAIL: Microsoft Edge was not found in Program Files or Program Files (x86).
exit /b 1
:fail_validation
echo FAIL: SVG validation failed. No PNG rendering was started.
exit /b 1
:fail_render
echo FAIL: A concept render or PNG verification failed. Export stopped.
exit /b 1
:fail_compare
echo FAIL: Comparison rendering or PNG verification failed.
exit /b 1
