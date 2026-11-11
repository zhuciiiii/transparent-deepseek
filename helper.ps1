# Win32 helper：全局快捷键（Ctrl+Alt+T / M / 0）+ 托盘图标。窗口透明由 Electron 的 transparent 窗口 + CSS 完成，这里不改窗口属性。
# （任务栏 AppUserModelID / 重新启动命令必须在 Harness 进程内设置，见 hook.js 里的 setAppDetails。）
# stdin  : "quit"
# stdout : "hotkey T|M|0" | "tray menu|magic|reset|quit"
param([string]$IconExe = '')

$src = @'
using System;
using System.Collections.Concurrent;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public static class Helper
{
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
    static readonly object outLock = new object();
    static void Out(string s) { lock (outLock) { Console.Out.WriteLine(s); Console.Out.Flush(); } }
    static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

    public static void Run(string iconExe)
    {
        var q = new ConcurrentQueue<string>();
        var th = new Thread(() => { string l; while ((l = Console.In.ReadLine()) != null) q.Enqueue(l); q.Enqueue("quit"); });
        th.IsBackground = true; th.Start();

        Application.EnableVisualStyles();
        var menu = new ContextMenuStrip();
        menu.Items.Add("打开皮肤设置 (Ctrl+Alt+T)", null, (s, e) => Out("tray menu"));
        menu.Items.Add("魔术模式 (Ctrl+Alt+M)", null, (s, e) => Out("tray magic"));
        menu.Items.Add("恢复原样 (Ctrl+Alt+0)", null, (s, e) => Out("tray reset"));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("最小化窗口", null, (s, e) => Out("tray winmin"));
        menu.Items.Add("最大化 / 还原窗口", null, (s, e) => Out("tray winmax"));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出美化工具", null, (s, e) => Out("tray quit"));
        var icon = new NotifyIcon();
        try { icon.Icon = (!string.IsNullOrEmpty(iconExe) && System.IO.File.Exists(iconExe)) ? Icon.ExtractAssociatedIcon(iconExe) : SystemIcons.Application; }
        catch (Exception) { icon.Icon = SystemIcons.Application; }
        icon.Text = "DeepSeek Harness 美化";
        icon.ContextMenuStrip = menu;
        icon.Visible = true;
        icon.DoubleClick += (s, e) => Out("tray reset");

        bool kT = false, kM = false, k0 = false, quit = false;
        var timer = new System.Windows.Forms.Timer();
        timer.Interval = 40;
        timer.Tick += (s, e) =>
        {
            string l;
            while (q.TryDequeue(out l)) { if (l.Trim() == "quit") quit = true; }
            if (quit) { icon.Visible = false; Application.ExitThread(); return; }
            bool ctrlAlt = Down(0x11) && Down(0x12);
            bool t = ctrlAlt && Down(0x54), m = ctrlAlt && Down(0x4D), z = ctrlAlt && (Down(0x30) || Down(0x60));
            if (t && !kT) Out("hotkey T");
            if (m && !kM) Out("hotkey M");
            if (z && !k0) Out("hotkey 0");
            kT = t; kM = m; k0 = z;
        };
        timer.Start();
        Application.Run();
    }
}
'@
Add-Type -TypeDefinition $src -ReferencedAssemblies System.Windows.Forms, System.Drawing
[Helper]::Run($IconExe)
