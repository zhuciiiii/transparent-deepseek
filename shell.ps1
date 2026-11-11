# Shell helper：快捷方式(.lnk)读写（含 AppUserModelID）、计划任务、窗口属性读取。输出统一 UTF-8 JSON。
# usage:
#   shell.ps1 -Cmd getlnk -Path <lnk>
#   shell.ps1 -Cmd scan -Roots "dir1;dir2" -OrigExe <exe> -VbsName launch.vbs      # 列出指向原程序/美化启动器的快捷方式
#   shell.ps1 -Cmd setlnk -Json <file.json>        # {Path,Target,Args,Icon,Wd,Desc,Id}
#   shell.ps1 -Cmd getwin -Hwnd <n>
#   shell.ps1 -Cmd tasks -OrigExe <exe>            # 动作里引用原程序的计划任务
#   shell.ps1 -Cmd taskexport -Name n -TaskPath p -Out file.xml
#   shell.ps1 -Cmd taskset -Name n -TaskPath p -Json <file.json>   # {Execute,Arguments,Wd}
#   shell.ps1 -Cmd taskrestore -Name n -TaskPath p -Xml file.xml
#   shell.ps1 -Cmd rtask-create -Name n -Execute e -Arguments a    # 登录时运行的任务
#   shell.ps1 -Cmd rtask-delete -Name n   |   rtask-exists -Name n
param([string]$Cmd, [string]$Path, [string]$Roots, [string]$OrigExe, [string]$VbsName = 'launch.vbs', [string]$Json, [string]$Hwnd,
      [string]$Name, [string]$TaskPath = '\', [string]$Out, [string]$Xml, [string]$Execute, [string]$Arguments)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

$src = @'
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential, Pack = 4)]
public struct PROPERTYKEY { public Guid fmtid; public uint pid; }

[StructLayout(LayoutKind.Explicit, Size = 24)]
public struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }

[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStore
{
    [PreserveSig] int GetCount(out uint c);
    [PreserveSig] int GetAt(uint i, out PROPERTYKEY k);
    [PreserveSig] int GetValue(ref PROPERTYKEY k, out PROPVARIANT v);
    [PreserveSig] int SetValue(ref PROPERTYKEY k, ref PROPVARIANT v);
    [PreserveSig] int Commit();
}

public static class ShellProps
{
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHGetPropertyStoreFromParsingName(string path, IntPtr bc, int flags, ref Guid iid, out IPropertyStore ps);
    [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid iid, out IPropertyStore ps);
    [DllImport("propsys.dll", CharSet = CharSet.Unicode)] static extern int InitPropVariantFromString(string s, out PROPVARIANT v);
    [DllImport("propsys.dll", CharSet = CharSet.Unicode)] static extern int PropVariantToStringAlloc(ref PROPVARIANT v, out IntPtr s);
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT v);

    static readonly Guid IID = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    static readonly Guid FMT = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    // pid: 2 RelaunchCommand, 3 RelaunchIconResource, 4 RelaunchDisplayNameResource, 5 AppUserModel.ID
    static PROPERTYKEY K(uint pid) { var k = new PROPERTYKEY(); k.fmtid = FMT; k.pid = pid; return k; }
    static string Read(IPropertyStore ps, uint pid)
    {
        var k = K(pid); PROPVARIANT v;
        if (ps.GetValue(ref k, out v) != 0) return null;
        try { if (v.vt == 0) return null; IntPtr s; if (PropVariantToStringAlloc(ref v, out s) != 0) return null; var r = Marshal.PtrToStringUni(s); Marshal.FreeCoTaskMem(s); return r; }
        finally { PropVariantClear(ref v); }
    }
    static void Write(IPropertyStore ps, uint pid, string val)
    {
        // InitPropVariantFromString 只是头文件里的内联函数，propsys.dll 并不导出：手工构造 VT_LPWSTR(31)
        var k = K(pid); var v = new PROPVARIANT();
        v.vt = 31; v.p = Marshal.StringToCoTaskMemUni(val);
        try { Marshal.ThrowExceptionForHR(ps.SetValue(ref k, ref v)); } finally { PropVariantClear(ref v); }
    }
    public static string GetLnkId(string path)
    {
        IPropertyStore ps; var iid = IID;
        Marshal.ThrowExceptionForHR(SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, 0, ref iid, out ps));
        return Read(ps, 5);
    }
    public static void SetLnkId(string path, string id)
    {
        IPropertyStore ps; var iid = IID;
        Marshal.ThrowExceptionForHR(SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, 2, ref iid, out ps));
        Write(ps, 5, id);
        Marshal.ThrowExceptionForHR(ps.Commit());
    }
    public static string GetWinId(long hwnd)
    {
        IPropertyStore ps; var iid = IID;
        Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(new IntPtr(hwnd), ref iid, out ps));
        return Read(ps, 5) + "|" + Read(ps, 2) + "|" + Read(ps, 3) + "|" + Read(ps, 4);
    }
}
'@
Add-Type -TypeDefinition $src

function Lnk-Info($file) {
    $sh = New-Object -ComObject WScript.Shell
    $l = $sh.CreateShortcut($file)
    $id = $null; try { $id = [ShellProps]::GetLnkId($file) } catch {}
    [pscustomobject]@{ Path = $file; Target = $l.TargetPath; Args = $l.Arguments; Icon = $l.IconLocation; Wd = $l.WorkingDirectory; Desc = $l.Description; Aumid = $id }
}

switch ($Cmd) {
    'getlnk' { Lnk-Info $Path | ConvertTo-Json -Compress }
    'scan' {
        $sh = New-Object -ComObject WScript.Shell
        $dirs = @($Roots -split ';' | ? { $_ })
        foreach ($f in 'Desktop', 'CommonDesktopDirectory', 'Programs', 'CommonPrograms', 'Startup', 'CommonStartup') { try { $dirs += [Environment]::GetFolderPath($f) } catch {} }
        $dirs = $dirs | ? { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique
        $res = @()
        foreach ($d in $dirs) {
            Get-ChildItem -LiteralPath $d -Filter *.lnk -Recurse -Force -ErrorAction SilentlyContinue | % {
                try {
                    $l = $sh.CreateShortcut($_.FullName)
                    $isOrig = ($l.TargetPath -ieq $OrigExe)
                    $isOurs = ($l.TargetPath -match 'wscript\.exe$') -and ($l.Arguments -match [regex]::Escape($VbsName))
                    if ($isOrig -or $isOurs) { $i = Lnk-Info $_.FullName; $i | Add-Member Kind ($(if ($isOrig) { 'orig' } else { 'ours' })); $res += $i }
                } catch {}
            }
        }
        # 去重（同一个文件可能被多个根目录包含）
        $seen = @{}; $uniq = @(); foreach ($r in $res) { if (-not $seen.ContainsKey($r.Path.ToLower())) { $seen[$r.Path.ToLower()] = 1; $uniq += $r } }
        ConvertTo-Json -InputObject @($uniq) -Compress -Depth 4
    }
    'setlnk' {
        $o = Get-Content -LiteralPath $Json -Raw -Encoding UTF8 | ConvertFrom-Json
        $sh = New-Object -ComObject WScript.Shell
        $l = $sh.CreateShortcut($o.Path)
        $l.TargetPath = $o.Target
        $l.Arguments = [string]$o.Args
        if ($o.Icon) { $l.IconLocation = $o.Icon }
        if ($o.Wd) { $l.WorkingDirectory = $o.Wd }
        if ($o.Desc) { $l.Description = $o.Desc }
        $l.WindowStyle = 7
        $l.Save()
        if ($o.Id) { [ShellProps]::SetLnkId($o.Path, $o.Id) }   # AUMID 必须最后设置
        'ok'
    }
    'getwin' { [ShellProps]::GetWinId([int64]$Hwnd) }
    'tasks' {
        $r = @(Get-ScheduledTask | ? { ($_.Actions | ? { $_.Execute -and ($_.Execute.Trim('"') -ieq $OrigExe) }) } | % {
            [pscustomobject]@{ Name = $_.TaskName; Path = $_.TaskPath; Execute = ($_.Actions | Select -First 1).Execute; Arguments = ($_.Actions | Select -First 1).Arguments; Wd = ($_.Actions | Select -First 1).WorkingDirectory } })
        ConvertTo-Json -InputObject @($r) -Compress
    }
    'taskexport' { Export-ScheduledTask -TaskName $Name -TaskPath $TaskPath | Out-File -LiteralPath $Out -Encoding UTF8; 'ok' }
    'taskset' {
        $o = Get-Content -LiteralPath $Json -Raw -Encoding UTF8 | ConvertFrom-Json
        $a = New-ScheduledTaskAction -Execute $o.Execute -Argument $o.Arguments -WorkingDirectory $o.Wd
        Set-ScheduledTask -TaskName $Name -TaskPath $TaskPath -Action $a | Out-Null; 'ok'
    }
    'taskrestore' { Register-ScheduledTask -TaskName $Name -TaskPath $TaskPath -Xml (Get-Content -LiteralPath $Xml -Raw -Encoding UTF8) -Force | Out-Null; 'ok' }
    'rtask-create' {
        $trg = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
        $act = New-ScheduledTaskAction -Execute $Execute -Argument $Arguments
        $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
        Register-ScheduledTask -TaskName $Name -Trigger $trg -Action $act -Settings $set -Description 'DeepSeek Harness beautify: repair shortcuts after updates' -Force | Out-Null; 'ok'
    }
    'rtask-delete' { Unregister-ScheduledTask -TaskName $Name -Confirm:$false; 'ok' }
    'rtask-exists' { if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) { 'yes' } else { 'no' } }
    default { 'unknown command' }
}
