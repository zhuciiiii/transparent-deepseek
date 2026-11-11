# 自动查找 DeepSeek Harness 的安装位置，写入同目录的 config.json；所有脚本都从 config.json 读取，不写死任何路径。
# 用法：
#   powershell -File detect.ps1                  检测并写 config.json（已有且有效就直接用），打印摘要
#   powershell -File detect.ps1 -Get exe|node|version|root   只输出一个字段（给 .bat / .vbs 用）
#   -Force    忽略已有 config.json 重新检测；  -NoPrompt  找不到时不弹选择窗口
# 检测顺序：a) 注册表卸载项  b) 开始菜单/桌面快捷方式  c) 常见默认位置  d) 弹窗让用户选择 "DeepSeek Harness.exe"
param([string]$Get = '', [switch]$Force, [switch]$NoPrompt, [switch]$Quiet)
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$CfgFile = Join-Path $Dir 'config.json'
$ExeName = 'DeepSeek Harness.exe'

function Say($m) { if (-not $Quiet -and -not $Get) { Write-Host $m } }
function Test-Exe($p) { return ($p -and (Test-Path -LiteralPath $p -PathType Leaf) -and ((Split-Path -Leaf $p) -ieq $ExeName)) }
function Exe-FromDir($d) { if (-not $d) { return $null }; $d = $d.Trim('"').Trim(); $p = Join-Path $d $ExeName; if (Test-Exe $p) { return $p }; return $null }

function Find-Registry {
  $roots = @('HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')
  foreach ($r in $roots) {
    if (-not (Test-Path $r)) { continue }
    foreach ($k in Get-ChildItem $r) {
      $x = Get-ItemProperty $k.PSPath
      if ($x.DisplayName -notlike '*DeepSeek Harness*') { continue }
      $c = Exe-FromDir $x.InstallLocation; if ($c) { return $c }
      if ($x.DisplayIcon) { $ic = ($x.DisplayIcon -split ',')[0].Trim('"'); if (Test-Exe $ic) { return $ic }; $c = Exe-FromDir (Split-Path -Parent $ic); if ($c) { return $c } }
      if ($x.UninstallString) { $u = $x.UninstallString; if ($u -match '^"([^"]+)"') { $c = Exe-FromDir (Split-Path -Parent $matches[1]); if ($c) { return $c } } }
    }
  }
  return $null
}

function Find-Shortcuts {
  $dirs = New-Object System.Collections.ArrayList
  foreach ($f in 'Programs', 'CommonPrograms', 'Desktop', 'CommonDesktopDirectory', 'Startup') { $p = [Environment]::GetFolderPath($f); if ($p) { [void]$dirs.Add($p) } }
  foreach ($e in 'OneDrive', 'OneDriveConsumer', 'OneDriveCommercial') { $o = [Environment]::GetEnvironmentVariable($e); if ($o) { [void]$dirs.Add((Join-Path $o 'Desktop')) } }
  $sh = New-Object -ComObject WScript.Shell
  foreach ($d in ($dirs | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $d)) { continue }
    foreach ($l in Get-ChildItem -LiteralPath $d -Filter '*.lnk' -Recurse -Depth 2) {
      if ($l.Name -notlike '*DeepSeek*' -and $l.Name -notlike '*Harness*') { continue }
      $s = $sh.CreateShortcut($l.FullName)
      if (Test-Exe $s.TargetPath) { return $s.TargetPath }
      # 已经被本工具改写过的快捷方式：目标是 wscript，原程序图标路径还在 IconLocation 里
      $ic = ($s.IconLocation -split ',')[0].Trim('"'); if (Test-Exe $ic) { return $ic }
    }
  }
  return $null
}

function Find-Common {
  $c = New-Object System.Collections.ArrayList
  foreach ($b in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if (-not $b) { continue }
    [void]$c.Add((Join-Path $b 'Programs\DeepSeek Harness')); [void]$c.Add((Join-Path $b 'DeepSeek Harness')); [void]$c.Add((Join-Path $b 'Programs\DeepSeek')); [void]$c.Add((Join-Path $b 'DeepSeek'))
  }
  foreach ($drv in [System.IO.DriveInfo]::GetDrives()) {
    if ($drv.DriveType -ne 'Fixed') { continue }
    $r = $drv.RootDirectory.FullName
    foreach ($s in 'DeepSeek\deep', 'DeepSeek\DeepSeek Harness', 'DeepSeek Harness', 'DeepSeek') { [void]$c.Add((Join-Path $r $s)) }
  }
  foreach ($d in $c) { $p = Exe-FromDir $d; if ($p) { return $p } }
  return $null
}

function Pick-Manually {
  if ($NoPrompt) { return $null }
  Add-Type -AssemblyName System.Windows.Forms
  [void][System.Windows.Forms.Application]::EnableVisualStyles()
  [void][System.Windows.Forms.MessageBox]::Show("没有自动找到 DeepSeek Harness。`n`n请在接下来的窗口里选择它的程序文件：`n$ExeName", '透明版 DeepSeek')
  $dlg = New-Object System.Windows.Forms.OpenFileDialog
  $dlg.Title = "选择 $ExeName"
  $dlg.Filter = "$ExeName|$ExeName"
  $dlg.CheckFileExists = $true
  if ($dlg.ShowDialog() -eq 'OK' -and (Test-Exe $dlg.FileName)) { return $dlg.FileName }
  return $null
}

function Find-Node($root) {
  $n = Join-Path $root 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
  if (Test-Path -LiteralPath $n) { return $n }
  $rt = Join-Path $root 'resources\runtime'
  if (Test-Path -LiteralPath $rt) { $f = Get-ChildItem -LiteralPath $rt -Filter node.exe -Recurse -Depth 6 | Select-Object -First 1; if ($f) { return $f.FullName } }
  # 最后才用系统里的 node（需要 22 以上：启动器用了内置的 fetch / WebSocket）
  $g = Get-Command node.exe; if ($g) { $v = (& $g.Source -v) -replace '^v', ''; if ([int](($v -split '\.')[0]) -ge 22) { return $g.Source } }
  return $null
}

function Load-Config {
  try { $c = Get-Content -LiteralPath $CfgFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
  if ($c -and (Test-Exe $c.exe) -and $c.node -and (Test-Path -LiteralPath $c.node)) { return $c }
  return $null
}

$cfg = $null
if (-not $Force) { $cfg = Load-Config }
if (-not $cfg) {
  $skip = [string]$env:BZ_DETECT_SKIP   # 仅用于测试：跳过某几步（registry,shortcut,common）
  $how = 'registry'; $exe = $null
  if ($skip -notlike '*registry*') { $exe = Find-Registry }
  if (-not $exe -and $skip -notlike '*shortcut*') { $how = 'shortcut'; $exe = Find-Shortcuts }
  if (-not $exe -and $skip -notlike '*common*') { $how = 'common-location'; $exe = Find-Common }
  if (-not $exe) { $how = 'user-selected'; $exe = Pick-Manually }
  if (-not $exe) { if (-not $Get) { Write-Host '[失败] 没有找到 DeepSeek Harness。' }; exit 1 }
  $root = Split-Path -Parent $exe
  $node = Find-Node $root
  if (-not $node) { if (-not $Get) { Write-Host "[失败] 在 $root 下找不到 Harness 自带的 node.exe，也没有可用的系统 Node（需要 22+）。" }; exit 2 }
  $ver = (Get-Item -LiteralPath $exe).VersionInfo.FileVersion
  $cfg = [ordered]@{ exe = $exe; root = $root; node = $node; version = $ver; detectedBy = $how; detectedAt = (Get-Date).ToString('s') }
  $json = $cfg | ConvertTo-Json
  [System.IO.File]::WriteAllText($CfgFile, $json, (New-Object System.Text.UTF8Encoding($false)))
  $cfg = $json | ConvertFrom-Json
  Say "已检测到 Harness（方式：$how）并写入 config.json"
}
if ($Get) { Write-Output ([string]$cfg.$Get); exit 0 }
Say "Harness 程序 : $($cfg.exe)"
Say "Harness 版本 : $($cfg.version)"
Say "Node        : $($cfg.node)"
exit 0
