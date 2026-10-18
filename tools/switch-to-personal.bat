@echo off
rem 切回个人 QQ。把本文件放在 QQ 安装目录（与 QQ.exe 同级）。
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0switch-qq.ps1" -Mode personal
if errorlevel 1 pause
ping -n 6 127.0.0.1 >nul
