# Transparent DeepSeek (a transparency skin for DeepSeek Harness)

[简体中文](README.md) | **English**

> An unofficial third-party tool, not affiliated with DeepSeek. It does **not** modify `app.asar`, so the app's auto-update keeps working.

A launcher that makes the DeepSeek Harness (Electron) window transparent and lets you control window opacity, text opacity and text colour independently — plus a minimal mode and a "magic" hide-on-blur mode.

## Requirements

- Windows 10/11 with DeepSeek Harness installed at `D:\DeepSeek\deep\`; put this folder at `D:\DeepSeek\beautify\`.
- The paths are hard-coded in `install.bat`, `start.bat`, `uninstall.bat`, `launch.vbs` and `repair.vbs` (the `NODE=` / `node =` lines). Edit them if your install location differs.
- Run `install.bat` once. To remove everything, run `uninstall.bat` (restores all original shortcuts).

## How to start

After `install.bat`, **every entry point (Start menu, desktop shortcut) launches the skinned Harness** through `wscript //B launch.vbs` — no console window. Original shortcuts are backed up to `backup\`. `start.bat` starts it with a console for debugging. If a plain (un-skinned) Harness is already running, clicking a shortcut closes it and restarts the skinned one; if the skinned one is running, it just brings the window to the front. No startup item is ever created. The launcher re-checks the shortcuts on each start, so they are repaired after an auto-update rewrites them (run `install.bat` again if you opened the original once).

## Features

- **Skin settings button** in the sidebar (above "Signed in"): opens a menu with window opacity, text opacity, text colour, minimal mode, magic mode and reset.
- **Window opacity 0–100%** — only backgrounds change (including the input box). At 0% only the text floats over your desktop; the window still receives clicks and typing. Opacity is linear: 50% really looks half transparent.
- **Text opacity 0–100%**, independent of window opacity: chat content, the whole input area (text, model picker, status bar, send button) and the whole title bar. Borders and dividers follow text opacity.
- **Text colour**: soft presets, a custom picker, HEX input and a "default" button; the opacity slider still applies on top; code blocks keep their syntax colours; secondary text keeps its relative contrast.
- **Everything with its own background in the chat** (inline code, code blocks, tables, badges, kbd, tooltips, menus…) follows window opacity; inline code keeps a faint outline at low opacity.
- **No blue**: the send button is a grey circle; the theme's blue CSS variables are replaced by grey.
- **Input box**: a very light layer (border, background, shadow) that never turns dark on hover/focus; pasted images show only as a faint `[Image N]` chip with a tiny × (the image is still sent as an attachment).
- **Minimal mode**: hides the sidebar, right panel, the entire title bar (menus and window buttons) and bottom panel, leaving only chat + input.
  - Resize from any edge or corner (invisible handles, minimum 240×120); a thin invisible strip at the top moves the window; content wraps, no horizontal scrollbar.
  - Under each answer only a small **Copy** button remains (shows ✓ after copying); like/dislike/share/usage/time, the "done in X s" line and thinking/tool blocks are hidden; thin scrollbar shown on hover.
  - Compact single-line input that grows up to ~5 lines; **no send button**: Enter sends, Shift+Enter inserts a newline, **Esc stops generation**.
  - No close button. Win+↓ minimizes; Win+↑ does not work (transparent-window limitation) — use the tray menu ("Minimize window" / "Maximize / restore window") or the taskbar icon. Leaving minimal mode restores everything.
- **Magic mode** (tied to window focus): when Harness loses focus the whole window fades out in ~0.12 s (done in the main process with `win.setOpacity`, no white flash); clicking back or Alt+Tab shows it instantly. Native dialogs/menus don't count as losing focus; a ~1% alpha layer keeps clicks from falling through; the wake-up click is swallowed.
- Settings persist in `settings.json`.

## Shortcuts (global, work even when the window is invisible)

| Shortcut | Action |
| --- | --- |
| Ctrl+Alt+T | Open/close the skin menu (in minimal mode it pops up at the bottom-left) |
| Ctrl+Alt+M | Toggle magic mode |
| Ctrl+Alt+0 | Reset everything to the original look |

Tray icon menu: skin settings / magic mode / reset / minimize window / maximize-restore window / quit (double-click = reset).

## How it works

1. The launcher starts Harness with `--inspect-brk` + `--remote-debugging-port` (the Electron fuse `EnableNodeCliInspectArguments` is on and asar integrity checking is off, so `app.asar` never needs patching). Before `main.js` runs, `hook.js` is executed over the Node inspector: it makes the main window `transparent: true` with a `#00000000` background (via a restricted getter on `Object.prototype`, because `BrowserWindow` is a native constructor), removes the native `titleBarOverlay` (the page draws its own window buttons), tracks focus for magic mode, and sets the AppUserModelID.
2. `inject.js` is injected over CDP (`Page.addScriptToEvaluateOnNewDocument`), only into Harness's own pages; settings are sent back via `Runtime.addBinding`.
3. Window opacity does **not** use `SetLayeredWindowAttributes` or colour keying. Large backgrounds become `rgba(original, alpha × windowOpacity)` written per element (only the bottom layer carries alpha, so it is linear); small chat elements are grouped by colour into a handful of CSSOM rules. Text opacity is the element `opacity` of ~10 targets. No root-level inherited variables drive the look (that forced full-tree restyles and 30 fps sliders).
4. `helper.ps1` provides global hotkeys and the tray icon; `shortcuts.js` + `shell.ps1` back up/rewrite/restore shortcuts.
5. The launcher is single-instance (control port 127.0.0.1:9342).

Internal ports / env vars: `DSH_PORT` (9223, page debugging), `DSH_INSPECT` (9341, main-process inspector), `DSH_CONTROL` (9342), `DSH_EXE`, `DSH_APPID`.

## Known limitations

- Window buttons are drawn by the page (the native overlay can't be made smaller or hidden); they look and behave the same, but without the Win11 snap-layout flyout.
- Large backgrounds are detected by area (≥ 9000 px²); after a Harness UI update a new large background may not turn transparent — selectors only use the stable suffix of CSS-module class names.
- Global hotkeys are polled (not registered), so they never conflict with other apps but can't block them either.
- Fully saturated solid colours (red/blue badges, primary buttons) are intentionally left unchanged.

## Files

`launch.vbs` / `repair.vbs` windowless entry & repair · `launcher.js` launcher · `hook.js` main-process hook · `inject.js` injected skin/menu/buttons · `shortcuts.js` + `shell.ps1` shortcut handling · `helper.ps1` hotkeys + tray · `install.bat` / `uninstall.bat` / `start.bat`.
