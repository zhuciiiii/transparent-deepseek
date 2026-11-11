@echo off
chcp 65001 >nul
title DeepSeek Harness 美化 - 安装入口
cd /d "%~dp0"
set "NODE=D:\DeepSeek\deep\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"
echo.
echo 把所有指向原版 DeepSeek Harness 的快捷方式（开始菜单、桌面、任务栏固定、启动文件夹）和开机自启项改成美化版。
echo 原快捷方式先备份到 %~dp0backup\shortcuts\ 。
echo.
"%NODE%" shortcuts.js install
echo.
"%NODE%" shortcuts.js status
echo.
pause
