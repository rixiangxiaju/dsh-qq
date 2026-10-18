@echo off
rem 切到机器人（NapCat）。把本文件放在 QQ 安装目录（与 QQ.exe 同级）。
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0switch-qq.ps1" -Mode bot
if errorlevel 1 pause
ping -n 8 127.0.0.1 >nul
