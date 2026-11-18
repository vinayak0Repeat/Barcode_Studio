@echo off
setlocal EnableExtensions
cd /d "%~dp0"
if errorlevel 1 goto :fail_cd

set "DRY_RUN=0"
set "CHOICE=%~1"
if /I "%~1"=="--dry-run" (
  set "DRY_RUN=1"
  set "CHOICE=%~2"
)

if /I "%CHOICE%"=="concept-a" set "SELECTED=concept-a.svg"
if /I "%CHOICE%"=="concept-b" set "SELECTED=concept-b.svg"
if /I "%CHOICE%"=="concept-c" set "SELECTED=concept-c.svg"
if not defined SELECTED goto :fail_usage
if not exist "%SELECTED%" goto :fail_source

set "EDGE="
if defined ProgramFiles(x86) if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined EDGE if defined ProgramFiles if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined EDGE goto :fail_edge

echo Validating SVG sources...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0validate-svg.ps1"
if errorlevel 1 goto :fail_validation

if "%DRY_RUN%"=="1" (
  echo PASS: %SELECTED% is valid. Dry run complete; no files were copied or overwritten.
  exit /b 0
)

if not exist "legacy-app-icon.svg" (
  copy /b "app-icon.svg" "legacy-app-icon.svg" >nul
  if errorlevel 1 goto :fail_backup
  echo PASS: saved legacy-app-icon.svg
) else (
  echo PASS: preserved existing legacy-app-icon.svg without overwriting it
)
if not exist "legacy-app-icon-bold.svg" (
  copy /b "app-icon-bold.svg" "legacy-app-icon-bold.svg" >nul
  if errorlevel 1 goto :fail_backup
  echo PASS: saved legacy-app-icon-bold.svg
) else (
  echo PASS: preserved existing legacy-app-icon-bold.svg without overwriting it
)

copy /b /y "%SELECTED%" "app-icon.svg" >nul
if errorlevel 1 goto :fail_copy
fc /b "%SELECTED%" "app-icon.svg" >nul
if errorlevel 1 goto :fail_copy
echo PASS: copied %SELECTED% to app-icon.svg

set "PAGE=file:///%CD:\=/%/render.html"
call :render app-icon.svg app-icon-1200.png 1200 ""
if errorlevel 1 goto :fail_export
call :render app-icon.svg final-preview-512.png 512 ""
if errorlevel 1 goto :fail_export
call :render app-icon.svg final-preview-128.png 128 ""
if errorlevel 1 goto :fail_export
call :render app-icon.svg final-preview-64.png 64 ""
if errorlevel 1 goto :fail_export
call :render app-icon.svg final-preview-32.png 32 ""
if errorlevel 1 goto :fail_export
call :render app-icon.svg final-preview-white.png 128 white 320
if errorlevel 1 goto :fail_export
call :render app-icon.svg final-preview-grey.png 128 grey 320
if errorlevel 1 goto :fail_export
call :render app-icon.svg final-preview-dark.png 128 dark 320
if errorlevel 1 goto :fail_export

echo PASS: final icon and all preview images were exported and verified.
exit /b 0

:render
set "SOURCE=%~1"
set "OUTPUT=%~2"
set "SIZE=%~3"
set "BACKGROUND=%~4"
set "WINDOW=%~5"
if not defined WINDOW set "WINDOW=%SIZE%"
set "QUERY=?src=%SOURCE%&size=%SIZE%"
if not "%BACKGROUND%"=="" set "QUERY=%QUERY%&bg=%BACKGROUND%"
echo Rendering %OUTPUT%...
"%EDGE%" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --run-all-compositor-stages-before-draw --virtual-time-budget=1200 --window-size=%WINDOW%,%WINDOW% --screenshot="%CD%\%OUTPUT%" "%PAGE%%QUERY%"
if errorlevel 1 exit /b 1
node verify-png.js %OUTPUT%@%WINDOW%x%WINDOW%
if errorlevel 1 exit /b 1
exit /b 0

:fail_cd
echo FAIL: Could not enter the icon asset folder.
exit /b 1
:fail_usage
echo Usage: finalize.cmd concept-a^|concept-b^|concept-c [--dry-run]
echo Safe check: finalize.cmd --dry-run concept-a
exit /b 2
:fail_source
echo FAIL: Selected concept file is missing: %SELECTED%
exit /b 1
:fail_edge
echo FAIL: Microsoft Edge was not found in Program Files or Program Files (x86).
exit /b 1
:fail_validation
echo FAIL: SVG validation failed. Nothing was copied.
exit /b 1
:fail_backup
echo FAIL: Could not preserve the current original icon files. Final icon was not copied.
exit /b 1
:fail_copy
echo FAIL: Could not install %SELECTED% as app-icon.svg.
exit /b 1
:fail_export
echo FAIL: Export or PNG verification failed. Finalization stopped.
exit /b 1
