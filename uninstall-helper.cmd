@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0helper\install-helper.ps1" -Uninstall
if errorlevel 1 echo Cast Volume helper removal failed.
pause
