@echo off
chcp 65001 >nul
title DeepSeek Harness 美化 - 卸载
cd /d "%~dp0"
set "NODE=D:\DeepSeek\deep\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"
echo.
echo 即将恢复所有原来的快捷方式、开机自启项，并删除登录时运行的修复任务。
echo （原快捷方式的备份在 %~dp0backup\shortcuts\，程序文件夹 deep\ 从未被修改。）
echo.
"%NODE%" shortcuts.js uninstall
echo.
echo 完成。如果美化版 Harness 还开着，退出后再用原来的快捷方式打开即可。
echo 想彻底删除美化工具：关闭 Harness 后删除整个 %~dp0 目录。
pause
