@echo off
chcp 65001 >nul
setlocal EnableExtensions
title 透明版 DeepSeek - 卸载
cd /d "%~dp0"
echo.
echo ==============  透明版 DeepSeek 卸载  ==============
echo.
set "NODE="
for /f "usebackq delims=" %%N in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0detect.ps1" -Get node -NoPrompt`) do set "NODE=%%N"
if not defined NODE goto :nonode
echo 恢复所有原来的快捷方式、开机自启项和计划任务，并删除修复任务 ...
echo.
"%NODE%" shortcuts.js uninstall
echo.
echo 完成。之后用原来的快捷方式打开就是原版 DeepSeek Harness。
echo 想彻底删除本工具：关闭 Harness 后删除整个本文件夹即可（Harness 本身不受影响）。
echo.
pause
exit /b 0

:nonode
echo [失败] 找不到 DeepSeek Harness（需要它自带的 Node 来运行卸载）。
echo        如果你已经卸载了 Harness，快捷方式本来就失效了，直接删除本文件夹即可。
echo.
pause
exit /b 1
