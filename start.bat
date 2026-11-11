@echo off
chcp 65001 >nul
setlocal EnableExtensions
title 透明版 DeepSeek - 调试启动（带控制台）
cd /d "%~dp0"
set "NODE="
for /f "usebackq delims=" %%N in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0detect.ps1" -Get node`) do set "NODE=%%N"
if not defined NODE goto :nonode
"%NODE%" launcher.js
if errorlevel 1 pause
exit /b 0

:nonode
echo [失败] 找不到 DeepSeek Harness。请先运行 install.bat。
pause
exit /b 1
