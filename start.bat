@echo off
chcp 65001 >nul
title DeepSeek Harness 美化启动器
cd /d "%~dp0"
set "NODE=D:\DeepSeek\deep\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" launcher.js
if errorlevel 1 pause
