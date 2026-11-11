@echo off
chcp 65001 >nul
setlocal EnableExtensions
title 透明版 DeepSeek - 安装
cd /d "%~dp0"
echo.
echo ==============  透明版 DeepSeek 安装  ==============
echo.

rem ---- 1. 系统版本 ----
set "BUILD="
for /f "usebackq delims=" %%V in (`powershell -NoProfile -Command "[Environment]::OSVersion.Version.Build"`) do set "BUILD=%%V"
if not defined BUILD goto :osunknown
if %BUILD% LSS 10240 goto :osold
echo [OK] 系统：Windows 10/11（内部版本 %BUILD%）
goto :findharness
:osunknown
echo [警告] 没能读取系统版本，继续尝试安装。
goto :findharness
:osold
echo [失败] 需要 Windows 10 或更高版本（当前内部版本 %BUILD%）。
goto :fail

rem ---- 2. 找 DeepSeek Harness（写入 config.json） ----
:findharness
echo.
echo 正在查找 DeepSeek Harness ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0detect.ps1"
if errorlevel 1 goto :noharness
set "NODE="
set "HVER="
set "HEXE="
for /f "usebackq delims=" %%N in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0detect.ps1" -Get node`) do set "NODE=%%N"
for /f "usebackq delims=" %%N in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0detect.ps1" -Get version`) do set "HVER=%%N"
for /f "usebackq delims=" %%N in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0detect.ps1" -Get exe`) do set "HEXE=%%N"
if not defined NODE goto :noharness
echo [OK] 已找到 DeepSeek Harness（版本 %HVER%）
goto :checkrun
:noharness
echo.
echo [失败] 没有找到 DeepSeek Harness。
echo        请先安装 DeepSeek Harness，再重新运行本文件；
echo        如果已经安装在特殊位置，重新运行后在弹出的窗口里选择 "DeepSeek Harness.exe" 即可。
goto :fail

rem ---- 3. Harness 是否正在运行 ----
:checkrun
tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /NH 2>nul | find /I "DeepSeek Harness.exe" >nul
if errorlevel 1 goto :doinstall
echo.
echo [提示] DeepSeek Harness 正在运行。
echo        建议先把它完全退出（托盘图标右键 - 退出）。关掉后按任意键继续；
echo        不关也可以，只是下次从快捷方式打开时才会变成透明版（那时会自动关掉旧窗口重开）。
pause >nul

rem ---- 4. 安装 ----
:doinstall
echo.
echo 把指向 DeepSeek Harness 的快捷方式（开始菜单、桌面、任务栏固定、启动文件夹）和开机自启项改成透明版。
echo 原快捷方式先备份到 "%~dp0backup\shortcuts\" 。不会修改 Harness 本身的任何文件。
echo.
"%NODE%" shortcuts.js install
if errorlevel 1 goto :fail
echo.
"%NODE%" shortcuts.js status
echo.
echo ==============  安装完成  ==============
echo 以后从开始菜单或桌面快捷方式打开 DeepSeek Harness 就是透明版。
echo 皮肤设置：侧边栏左下角按钮，或按 Ctrl+Alt+T；恢复原样 Ctrl+Alt+0。
echo 卸载：运行 uninstall.bat。
echo.
pause
exit /b 0

:fail
echo.
echo 安装没有完成。
echo.
pause
exit /b 1
