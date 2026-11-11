// 注入到 DeepSeek Harness 页面的脚本：样式 + 侧边栏「皮肤设置」按钮 + 向上弹出的设置菜单 + 字体颜色调色盘。
// 启动器会在它前面拼接 `window.__BZ_INIT = {...设置...};`，并用 Page.addScriptToEvaluateOnNewDocument 在页面最早阶段执行。
// 前提：聊天主窗口已被 hook.js 以 transparent:true 创建；隐藏/显示（魔术模式）完全由主进程 win.setOpacity 完成，页面不参与外观。
//
// 性能设计（拖动滑块/调色盘要跟手，聊天/流式输出时不能卡）：
//  - 不用「根上的继承变量」驱动外观：改继承变量会让整棵 DOM 树重新计算样式（实测约 10ms/帧）。
//    窗口透明度 = 少数几个「有背景的大元素」自己的 background-color；文字透明度 = 约 10 个目标元素自己的 opacity。
//    只有字体颜色用根上的一个变量 --bz-rgb（整棵树重算一次，拖动时用 rAF 合并并限频）。
//  - 所有更新用 requestAnimationFrame 合并；设置回传启动器防抖；启动器再防抖 300ms 写盘。
//  - 不逐个扫描整棵 DOM：MutationObserver 只处理新增节点，在 rAF 里按时间预算分批处理（流式输出不会卡）。
(() => {
  'use strict';
  if (location.protocol !== 'dsh-app:' && !(window.__BZ_PANEL && location.protocol === 'about:')) return; // about:blank 只有「小窗口设置面板」（hook.js 开的独立窗口，启动器注入时带 __BZ_PANEL）会套用；// 只给 Harness 自己的页面套皮肤，不碰 webview 里打开的第三方网页
  if (window.__bz && window.__bz.destroy) { try { window.__bz.destroy(); } catch (e) {} }

  const DEFAULTS = {
    opacity: 100,     // 窗口透明度（只影响背景）0-100
    textFade: 100,    // 文字透明度（只影响文字/图标/前景）0-100
    minimal: false,   // 极简模式
    magic: false,     // 魔术模式（失焦自动隐形，由主进程处理；不持久化）
    textColor: '',    // 字体颜色 '#rrggbb'；空 = 程序原来的颜色
    colorIcons: false // 图标、按钮、边框、窗口按钮是否也跟随字体颜色
  };
  let S = Object.assign({}, DEFAULTS, window.__BZ_INIT || {});

  // Harness 用 CSS Modules（哈希前缀会变），只匹配稳定的后缀
  const SEL = {
    frame: '[class*="_frame"]',
    sidebar: '[class*="_sidebarCol"]',
    right: '[class*="_rightbarCol"]',
    bottom: '[class*="_bottomRow"]',
    handle: '[class*="_frame"] > [class*="_handle"]',
    header: '[class*="_centerCol"] header',
    composer: '[class*="_composerStack"]',
    composerAdd: '[class*="_composerStack"] [class*="_add"]',
    composerModes: '[class*="_composerStack"] [class*="_modes"]',
    footerActions: '[class*="_footerActions"]',
    panelRow: '[class*="_panelRow"]',
  };
  const CARD_SEL = SEL.composer + ' [class*="_card"]';
  // 「文字透明度」目标：聊天内容区、整条标题栏、输入区前景（输入文字/模型选择/发送按钮/状态栏）、窗口按钮
  const OPACITY_SEL = [
    '[data-windows-menu]', '[class*="_sidebarCol"] [class*="_toggle"]', '[class*="_centerCol"] header',
    '[class*="_rightbarCol"] [class*="_tabHostHeader"]', '[class*="_viewArea"]',
    '[class*="_composerStack"] [class*="_scroll"]', '[class*="_composerStack"] [class*="_rail"]', '[class*="_composerStack"] [class*="_row"]', '[class*="_composerStack"] [class*="_dock"]', '#bz-wc',
  ].join(',');
  const TARGET_SEL = OPACITY_SEL + ',' + CARD_SEL;
  const UI = '#bz-menu, #bz-veil, #bz-btn, #bz-wc, #bz-style, #bz-accent, #bz-color';

  // ---------- 静态样式（不随滑块变化，只插入一次） ----------
  const css = `
@property --bz-t  { syntax: '<number>'; inherits: false; initial-value: 1; }
@property --bz-pb { syntax: '<color>';  inherits: false; initial-value: transparent; }
@property --bz-pa { syntax: '<color>';  inherits: false; initial-value: transparent; }
[data-bz-pb]::before { background-color: var(--bz-pb) !important; }
[data-bz-pa]::after  { background-color: var(--bz-pa) !important; }

/* 输入区：光标灰色；发送按钮灰色圆形 + 白色箭头 */
${SEL.composer} * { caret-color: rgb(140,140,140) !important; }
${SEL.composer} button[class*="_primary"] { background-color: rgb(205,207,211) !important; color: #fff !important; border-color: transparent !important; }
${SEL.composer} button[class*="_primary"]:disabled, ${SEL.composer} button[class*="_primary"][aria-disabled="true"] { opacity: .55; }
/* 输入框卡片：原生边框/描边/外圈阴影/聚焦蓝框都去掉，改成灰色并跟「文字透明度」联动（--bz-t 只设在卡片元素自己身上）；底色跟窗口透明度 */
html { --bz-ring-rgb: 190 190 190; --bz-ring-a: .55; --bz-focus-rgb: 190 190 190; --bz-drop-a: .035; }
html[data-bz-theme="dark"] { --bz-ring-rgb: 255 255 255; --bz-ring-a: .16; --bz-focus-rgb: 255 255 255; --bz-drop-a: .2; }
${CARD_SEL} {
  border-color: transparent !important; outline: none !important;
  box-shadow: 0 0 0 1px rgb(var(--bz-ring-rgb) / calc(var(--bz-ring-a) * var(--bz-t))),
              0 6px 22px rgb(0 0 0 / calc(var(--bz-drop-a) * var(--bz-t))) !important;
}
${CARD_SEL}:focus-within {
  box-shadow: 0 0 0 1px rgb(var(--bz-focus-rgb) / calc(var(--bz-ring-a) * 1.12 * var(--bz-t))),
              0 6px 22px rgb(0 0 0 / calc(var(--bz-drop-a) * var(--bz-t))) !important;
}

/* 极简模式 */
html.bz-min ${SEL.sidebar}, html.bz-min ${SEL.right}, html.bz-min ${SEL.bottom},
html.bz-min ${SEL.handle}, html.bz-min ${SEL.header},
html.bz-min ${SEL.composerAdd}, html.bz-min ${SEL.composerModes} { display: none !important; }
html.bz-min ${SEL.frame} { grid-template-columns: 0px minmax(0,1fr) 0px !important; }

/* 窗口按钮：原生按钮在窗口创建时就去掉了，这里自己画；极简模式不画关闭键 */
#bz-wc { position: fixed; top: 0; right: 0; height: 40px; z-index: 2147483644; display: flex; -webkit-app-region: no-drag; }
html.bz-min #bz-wc, html.bz-min [data-windows-menu] { display: none !important; }
html.bz-min { --dsh-windows-titlebar-height: 0px !important; }
html.bz-min ${SEL.frame} { padding-top: 0 !important; }

/* 极简模式：窗口缩放边 + 顶部拖动条 + 自适应换行 + 精简输入框 */
#bz-rs { display: none; }
html.bz-min #bz-rs { display: block; }
#bz-rs i { position: fixed; z-index: 2147483643; -webkit-app-region: no-drag; }
#bz-rs i[data-e="n"]  { top: 0; left: 8px; right: 8px; height: 5px; cursor: ns-resize; }
#bz-rs i[data-e="s"]  { bottom: 0; left: 8px; right: 8px; height: 6px; cursor: ns-resize; }
#bz-rs i[data-e="e"]  { right: 0; top: 8px; bottom: 8px; width: 6px; cursor: ew-resize; }
#bz-rs i[data-e="w"]  { left: 0; top: 8px; bottom: 8px; width: 6px; cursor: ew-resize; }
#bz-rs i[data-e="ne"] { top: 0; right: 0; width: 10px; height: 10px; cursor: nesw-resize; }
#bz-rs i[data-e="sw"] { bottom: 0; left: 0; width: 10px; height: 10px; cursor: nesw-resize; }
#bz-rs i[data-e="nw"] { top: 0; left: 0; width: 10px; height: 10px; cursor: nwse-resize; }
#bz-rs i[data-e="se"] { bottom: 0; right: 0; width: 10px; height: 10px; cursor: nwse-resize; }
#bz-drag { position: fixed; z-index: 2147483642; top: 5px; left: 10px; right: 10px; height: 10px; -webkit-app-region: drag; }
html.bz-min, html.bz-min body { overflow-x: hidden !important; }
html.bz-min ${SEL.frame}, html.bz-min [class*="_centerCol"], html.bz-min [class*="_viewArea"] { min-width: 0 !important; max-width: 100vw; overflow-x: hidden !important; }
html.bz-min [class*="_viewArea"] * { overflow-wrap: anywhere; }
html.bz-min [class*="_viewArea"] pre, html.bz-min [class*="_viewArea"] pre code { white-space: pre-wrap !important; word-break: break-all; overflow-x: hidden !important; max-width: 100%; }
html.bz-min [class*="_viewArea"] table { display: block; max-width: 100%; overflow-x: hidden; table-layout: fixed; }
html.bz-min [class*="_viewArea"] img, html.bz-min [class*="_viewArea"] video { max-width: 100%; height: auto; }
/* 回答下面的操作栏只留「复制」（小号、右下角）；点赞/点踩/分享/用量/时间、「已完成，用时」行、思考/工具过程整块隐藏 */
html.bz-min [class*="_viewArea"] [class*="_actions"]:is(:has(> button[aria-label="在新对话中分支"]), :has(> [class*="_time"])) { min-height: 0 !important; height: 20px !important; padding: 0 !important; margin: 0 !important; justify-content: flex-end !important; gap: 0 !important; }
html.bz-min [class*="_viewArea"] [class*="_actions"]:is(:has(> button[aria-label="在新对话中分支"]), :has(> [class*="_time"])) > :not(button[aria-label="复制"]) { display: none !important; }
html.bz-min [class*="_viewArea"] [class*="_actions"]:is(:has(> button[aria-label="在新对话中分支"]), :has(> [class*="_time"])) > button[aria-label="复制"] { width: 20px !important; height: 20px !important; min-width: 20px !important; padding: 0 !important; position: relative; }
html.bz-min [class*="_viewArea"] [class*="_actions"] > button[aria-label="复制"] svg { width: 13px !important; height: 13px !important; }
html.bz-min [class*="_viewArea"] button.bz-copied svg { visibility: hidden; }
html.bz-min [class*="_viewArea"] button.bz-copied::after { content: "\\2713"; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 13px; line-height: 1; }
html.bz-min [class*="_viewArea"] [class*="_flowItem"]:has(> div > [class*="_visuallyHidden"]):has([class*="_durationNumber"]),
html.bz-min [class*="_viewArea"] [class*="_root"]:has(> div > button[class*="_title"]) { display: none !important; }
/* 思考过程/工具调用过程整块隐藏（上面那条 :has(> div > button[class*="_title"])）；生成中原来的「深度求索中，用时 N 秒」整行换成一个很小的淡色跳动省略号，
   答案一开始输出（紧挨在它前面的兄弟是带 markdown 的答案块）就消失。纯 CSS：流式新生成的块一插入就生效，不会先闪出来 */
html.bz-min [class*="_viewArea"] [class*="_running"] { display: flex !important; align-items: center; height: 22px !important; min-height: 0 !important; padding: 0 !important; margin: 0 !important; border: 0 !important; }
html.bz-min [class*="_viewArea"] [class*="_running"] > :not([class*="_visuallyHidden"]) { display: none !important; }
html.bz-min [class*="_viewArea"] [class*="_running"]::after { content: "·"; font: 700 22px/22px "Microsoft YaHei UI", system-ui, sans-serif; letter-spacing: 3px; opacity: .55; animation: bzdots 1.1s steps(1) infinite; }
@keyframes bzdots { 0% { content: "·"; } 33% { content: "· ·"; } 66% { content: "· · ·"; } }
html.bz-min [class*="_viewArea"] [class*="_flowItem"]:has([class*="_markdown"]) + [class*="_running"] { display: none !important; }
/* 极简：细滚动条，只在悬停/滚动（鼠标在其上）时出现 */
html.bz-min *::-webkit-scrollbar { width: 4px !important; height: 4px !important; background: transparent !important; }
html.bz-min *::-webkit-scrollbar-track, html.bz-min *::-webkit-scrollbar-corner { background: transparent !important; }
html.bz-min *::-webkit-scrollbar-thumb { background: transparent !important; border-radius: 2px; }
html.bz-min *:hover::-webkit-scrollbar-thumb { background: rgba(128,128,128,.45) !important; }

/* 粘贴的图片：不显示缩略图，只显示很淡的小标签「[图片N]」+ 很小的 ×（图片仍作为附件发送；普通/极简都一样） */
${CARD_SEL} [class*="_rail"] { counter-reset: bzimg; height: auto !important; min-height: 0 !important; max-height: none !important; padding: 0 !important; margin: 4px 0 0 !important; gap: 4px !important; border: 0 !important; box-shadow: none !important; background: none !important; flex-wrap: wrap !important; overflow: visible !important; }
${CARD_SEL} [class*="_rail"] [class*="_root"] { height: auto !important; min-height: 0 !important; padding: 0 !important; margin: 0 !important; gap: 4px !important; border: 0 !important; }
${CARD_SEL} [class*="_item"]:has([class*="_imageItem"]) { width: auto !important; height: auto !important; min-width: 0 !important; }
${CARD_SEL} [class*="_imageItem"] { counter-increment: bzimg; display: inline-flex !important; align-items: center; width: auto !important; height: 20px !important; padding: 0 3px 0 8px !important; border-radius: 10px !important; background: rgba(127,127,127,.12) !important; border: 0 !important; box-shadow: none !important; overflow: visible !important; }
${CARD_SEL} [class*="_imageItem"] [class*="_thumbnail"] { width: auto !important; height: auto !important; min-width: 0 !important; padding: 0 !important; border: 0 !important; background: none !important; box-shadow: none !important; border-radius: 0 !important; font: 12px/20px "Microsoft YaHei UI", system-ui, sans-serif; color: rgb(150,154,160); }
${CARD_SEL} [class*="_imageItem"] [class*="_thumbnail"] img { display: none !important; }
${CARD_SEL} [class*="_imageItem"] [class*="_thumbnail"]::before { content: "[图片" counter(bzimg) "]"; }
${CARD_SEL} [class*="_imageItem"] [class*="_remove"] { position: static !important; width: 14px !important; height: 14px !important; min-width: 14px !important; margin: 0 0 0 2px !important; padding: 0 !important; border: 0 !important; background: none !important; box-shadow: none !important; opacity: .65; color: rgb(150,154,160) !important; }
${CARD_SEL} [class*="_imageItem"] [class*="_remove"] svg { width: 8px !important; height: 8px !important; }
html.bz-min ${CARD_SEL} { flex-wrap: wrap !important; }
html.bz-min ${CARD_SEL} [class*="_rail"] { flex: 0 0 100% !important; box-sizing: border-box; padding-left: 10px !important; }
/* 极简：不要发送键，只用回车发送；Esc 在生成中代替「停止」键（见 onEsc） */
html.bz-min ${CARD_SEL} [class*="_row"] { display: none !important; }

/* 输入区：只留输入框 + 发送按钮；单行紧凑，发送键在右侧内部，多行自动长高，最多约 5 行再滚动 */
html.bz-min ${SEL.composer} [class*="_dock"],
html.bz-min ${SEL.composer} [class*="_row"] [class*="_tools"],
html.bz-min ${SEL.composer} [class*="_standardControls"],
html.bz-min ${SEL.composer} [class*="_activity"] { display: none !important; }
html.bz-min ${SEL.composer} { padding-bottom: 6px !important; }
html.bz-min ${CARD_SEL} { flex-direction: row !important; align-items: flex-end !important; min-height: 36px !important; padding: 0 !important; width: 100% !important; box-sizing: border-box; border-radius: 18px !important; }
html.bz-min ${CARD_SEL} [class*="_scroll"] { flex: 1 1 auto; min-width: 0; max-height: 124px !important; overflow-y: auto !important; padding: 0 !important; margin: 0 !important; }
html.bz-min ${CARD_SEL} [class*="_input"] { min-height: 22px !important; padding: 7px 4px 7px 14px !important; line-height: 22px !important; box-sizing: border-box; }
html.bz-min ${CARD_SEL} [class*="_placeholder"] { left: 14px !important; top: 7px !important; right: 4px !important; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 22px !important; height: 22px !important; }
html.bz-min ${CARD_SEL} [class*="_row"] { flex: 0 0 auto !important; width: auto !important; min-height: 0 !important; padding: 3px 3px 3px 0 !important; margin: 0 !important; align-self: flex-end; }
html.bz-min ${CARD_SEL} [class*="_trailing"] { flex: 0 0 30px !important; width: 30px !important; min-width: 30px !important; padding: 0 !important; gap: 0 !important; }
html.bz-min ${CARD_SEL} [class*="_row"] { min-width: 36px !important; }
html.bz-min ${CARD_SEL} button[class*="_primary"] { width: 30px !important; height: 30px !important; min-width: 30px !important; }
#bz-wc [data-op="close"]:hover { background: #e81123; color: #fff; }
#bz-wc button { all: unset; box-sizing: border-box; width: 46px; height: 40px; display: flex; align-items: center; justify-content: center; cursor: default; }
#bz-wc button:hover { background: rgba(127,127,127,.18); }
#bz-wc svg { width: 10px; height: 10px; stroke: currentColor; fill: none; stroke-width: 1; }

/* 魔术模式：外观完全由主进程 setOpacity 控制；页面只在窗口失焦时放一层几乎不可见的 veil，用来吞掉「唤醒那一下点击」 */
#bz-veil { position: fixed; inset: 0; z-index: 2147483646; display: none; background: rgba(0,0,0,.01); -webkit-app-region: no-drag; cursor: default; }
html.bz-away #bz-veil, html.bz-wake #bz-veil { display: block; }

/* 弹出菜单 */
#bz-menu { position: fixed; z-index: 2147483645; box-sizing: border-box; width: 292px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); overflow-x: hidden; overflow-y: auto; padding: 12px 14px 10px; border-radius: 12px;
  font: 13px/1.45 "Microsoft YaHei UI", system-ui, sans-serif; user-select: none; -webkit-app-region: no-drag;
  background: #fff; color: #0f1115; border: 1px solid rgba(0,0,0,.1); box-shadow: 0 8px 28px rgba(0,0,0,.18); }
#bz-menu.bz-dark { background: #26262b; color: #f2f2f4; border-color: rgba(255,255,255,.12); box-shadow: 0 8px 28px rgba(0,0,0,.5); }
#bz-menu[hidden] { display: none; }
#bz-menu::-webkit-scrollbar { width: 4px; background: transparent; }
#bz-menu::-webkit-scrollbar-track { background: transparent; }
#bz-menu::-webkit-scrollbar-thumb { background: rgba(128,128,128,.45); border-radius: 2px; }
#bz-menu .bz-r label > span, #bz-menu .bz-c > span, #bz-menu .bz-k { overflow-wrap: anywhere; min-width: 0; }
#bz-menu .bz-colorrow > span { min-width: 0; overflow-wrap: anywhere; }
#bz-menu .bz-dot { flex: 0 0 20px; margin-left: 8px; }
#bz-menu .bz-c input { flex: 0 0 auto; }
/* 小窗口里的独立设置窗口：菜单铺满整个窗口 */
html.bz-panelwin, html.bz-panelwin body { margin: 0 !important; overflow: hidden !important; background: #fff !important; }
html.bz-panelwin.bz-pdark, html.bz-panelwin.bz-pdark body { background: #26262b !important; }
html.bz-panelwin #bz-menu { inset: 0 !important; width: auto !important; max-width: none !important; max-height: none !important; border-radius: 0 !important; border: 0 !important; box-shadow: none !important; padding: 14px 16px !important; }
html.bz-panelwin #bz-rs, html.bz-panelwin #bz-wc, html.bz-panelwin #bz-veil { display: none !important; }
html.bz-dragging, html.bz-dragging * { user-select: none !important; cursor: grabbing !important; }
#bz-menu * { box-sizing: border-box; color: inherit !important; }
#bz-menu .bz-ttl { font-weight: 600; margin-bottom: 6px; }
#bz-menu .bz-r { margin: 9px 0; }
#bz-menu .bz-r label { display: flex; justify-content: space-between; align-items: center; margin-bottom: 3px; opacity: .72; }
#bz-menu input[type=range] { width: 100%; margin: 0; accent-color: #8a8f98; background: none; }
#bz-menu .bz-c { display: flex; align-items: center; gap: 8px; margin: 10px 0; cursor: pointer; }
#bz-menu .bz-c input { margin: 0; accent-color: #8a8f98; }
#bz-menu .bz-b { all: unset; display: block; width: 100%; text-align: center; cursor: pointer; margin-top: 7px; padding: 6px 8px; border-radius: 8px; background: rgba(127,127,127,.14); box-sizing: border-box; color: inherit; }
#bz-menu .bz-b:hover { background: rgba(127,127,127,.26); }
#bz-menu .bz-k { margin-top: 9px; font-size: 11px; opacity: .55; }
/* 字体颜色行 + 调色盘 */
#bz-menu .bz-colorrow { display: flex; justify-content: space-between; align-items: center; margin: 9px 0; cursor: pointer; }
#bz-menu .bz-colorrow > span { opacity: .72; }
#bz-menu .bz-dot { all: unset; width: 20px; height: 20px; border-radius: 50%; cursor: pointer; border: 1px solid rgba(127,127,127,.55); box-sizing: border-box; display: flex; align-items: center; justify-content: center; font-size: 11px; background: transparent; }
#bz-menu .bz-pal { margin: 4px 0 8px; padding: 8px; border-radius: 10px; background: rgba(127,127,127,.1); }
#bz-menu .bz-pal[hidden] { display: none; }
#bz-menu .bz-sw { display: grid; grid-template-columns: repeat(9, 1fr); gap: 5px; margin-bottom: 8px; }
#bz-menu .bz-sw button { all: unset; height: 20px; border-radius: 6px; cursor: pointer; border: 1px solid rgba(127,127,127,.4); box-sizing: border-box; }
#bz-menu .bz-sw button:hover { transform: scale(1.12); }
#bz-menu .bz-sv { position: relative; height: 96px; border-radius: 8px; cursor: crosshair; touch-action: none; border: 1px solid rgba(127,127,127,.4); }
#bz-menu .bz-svp { position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 0 1px rgba(0,0,0,.5); pointer-events: none; }
#bz-menu .bz-hue { position: relative; height: 12px; margin: 8px 0; border-radius: 6px; cursor: pointer; touch-action: none; background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00); }
#bz-menu .bz-huep { position: absolute; top: -2px; width: 8px; height: 16px; margin-left: -4px; border-radius: 4px; border: 2px solid #fff; box-shadow: 0 0 0 1px rgba(0,0,0,.5); pointer-events: none; }
#bz-menu .bz-hexrow { display: flex; gap: 6px; align-items: center; }
#bz-menu .bz-hex { all: unset; flex: 1; padding: 4px 8px; border-radius: 6px; border: 1px solid rgba(127,127,127,.45); font: 12px/1.4 Consolas, monospace; box-sizing: border-box; user-select: text; }
#bz-menu .bz-hexrow .bz-b { width: auto; margin: 0; padding: 4px 10px; }
`;

  // ---------- 小工具 ----------
  const raf = (fn) => requestAnimationFrame(fn);
  const call = (msg) => { try { window.__bzCall(JSON.stringify(msg)); } catch (e) {} };
  const isTransparent = (s) => !s || s === 'rgba(0, 0, 0, 0)' || s === 'transparent';
  const colorCache = new Map();
  let canvasCtx = null;
  function parseColor(str) {
    let v = colorCache.get(str);
    if (v) return v;
    const m = /^rgba?\(([^)]+)\)$/.exec(str);
    if (m) {
      const p = m[1].split(/[\s,\/]+/).filter(Boolean).map((x) => (x.endsWith('%') ? parseFloat(x) / 100 : parseFloat(x)));
      v = [p[0], p[1], p[2], p.length >= 4 ? p[3] : 1];
    } else { // color(srgb ...) 等写法：用画布归一化
      if (!canvasCtx) canvasCtx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      canvasCtx.clearRect(0, 0, 1, 1); canvasCtx.fillStyle = str; canvasCtx.fillRect(0, 0, 1, 1);
      const d = canvasCtx.getImageData(0, 0, 1, 1).data;
      v = [d[0], d[1], d[2], d[3] / 255];
    }
    colorCache.set(str, v);
    return v;
  }
  const lum = (r, g, b) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const hexOk = (h) => /^#[0-9a-fA-F]{6}$/.test(h || '');
  const hexToRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const rgbToHex = (r, g, b) => '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
    return [h, mx ? d / mx : 0, mx];
  }
  function hsvToRgb(h, s, v) {
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0]; else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c]; else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
  }

  // ---------- 生命周期：根元素/body 出现之前脚本就已经在跑，所以所有 DOM 操作都要等对应节点 ----------
  const cleanups = [];
  function whenRoot(fn) {
    if (document.documentElement) return fn();
    const mo = new MutationObserver(() => { if (document.documentElement) { mo.disconnect(); fn(); } });
    mo.observe(document, { childList: true });
    cleanups.push(() => mo.disconnect());
  }
  function whenBody(fn) {
    if (document.body) return fn();
    const mo = new MutationObserver(() => { if (document.body) { mo.disconnect(); fn(); } });
    mo.observe(document.documentElement || document, { childList: true, subtree: !document.documentElement });
    cleanups.push(() => mo.disconnect());
  }
  function whenReady(fn) {
    if (document.readyState !== 'loading') return fn();
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  }

  let styleEl = null;
  function injectStyle() {
    styleEl = document.createElement('style');
    styleEl.id = 'bz-style';
    styleEl.textContent = css;
    (document.head || document.documentElement).appendChild(styleEl);
  }

  // ---------- 与启动器通信 ----------
  let sendTimer = null, pending = {}, lastLocalSet = 0, dragging = 0;
  function set(patch) {
    Object.assign(S, patch);
    lastLocalSet = performance.now();
    for (const k in patch) dirty[k] = true;
    scheduleApply();
    Object.assign(pending, patch);
    if (!sendTimer) sendTimer = setTimeout(() => { sendTimer = null; call({ type: 'set', patch: pending }); pending = {}; }, 60);
  }

  // ---------- 脏标记 + rAF 合并 ----------
  const dirty = {};
  let applyQueued = false;
  function scheduleApply() { if (!applyQueued) { applyQueued = true; raf(applyAll); } }
  function applyAll() {
    applyQueued = false;
    const d = Object.assign({}, dirty); for (const k in dirty) delete dirty[k];
    if (d.opacity || d.all) applyBg();
    if (d.textFade || d.all) applyText();
    if (d.minimal || d.magic || d.all) applyClasses();
    if (d.textColor || d.colorIcons || d.all) applyColor();
    if (menu && (d.all || d.menu || Object.keys(d).length)) syncMenu();
  }
  const dirtyAll = () => { dirty.all = true; scheduleApply(); };

  // ---------- 窗口透明度：少数「有背景的大元素」自己的 background-color（字面 rgba，不用继承变量） ----------
  const MIN_AREA = 9000; // css px²
  const FLOOR = 0.004;   // html/body 底层保留 1/255 的 alpha，保证窗口 0% 时仍能接收点击/输入
  let entries = [];      // { el, fn(k), undo[] }
  let seen = new WeakSet();
  const rgbaStr = (c, k, floor) => { const a = c[3] * k; return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (floor ? Math.max(FLOOR, a) : a).toFixed(3) + ')'; };
  // 渐变 / 阴影：把字符串里每个颜色记成模板，按 k 重新拼
  function colorTemplate(str) {
    const re = /(rgba?\([^)]*\)|color\(srgb[^)]*\))/g;
    const parts = [], cols = []; let last = 0, m;
    while ((m = re.exec(str))) { parts.push(str.slice(last, m.index)); cols.push(parseColor(m[1])); last = m.index + m[1].length; }
    parts.push(str.slice(last));
    return (k) => { let s = parts[0]; for (let i = 0; i < cols.length; i++) s += 'rgba(' + cols[i][0] + ',' + cols[i][1] + ',' + cols[i][2] + ',' + (cols[i][3] * k).toFixed(3) + ')' + parts[i + 1]; return s; };
  }
  // 输入区底部的白色渐变遮罩（composerSeat）、侧边栏列表底部的渐隐（fade）：这些元素创建时可能还没有尺寸，所以强制处理 + 零尺寸重查
  const FORCE_SEL = '[class*="_composerSeat"], [class*="_fade"]';
  const pendingZero = new Set();
  let bgOf = new WeakMap();  // 元素 -> 原始背景色（用来找「最近的有底色的祖先」）
  const colorNear = (a, b) => Math.abs(a[0] - b[0]) <= 14 && Math.abs(a[1] - b[1]) <= 14 && Math.abs(a[2] - b[2]) <= 14;
  const forcedDone = new WeakSet();
  function recheckForced() {
    const redo = [];
    for (const el of document.querySelectorAll(FORCE_SEL)) {
      if (forcedDone.has(el)) continue;
      const bi = getComputedStyle(el).backgroundImage;
      if (bi && bi.includes('gradient(')) { forcedDone.add(el); seen.delete(el); redo.push(el); }
    }
    if (redo.length) examine(redo);
  }
  function recheckPending() {
    if (S.opacity !== 100 || entries.length) recheckForced();
    if (!pendingZero.size) return;
    const redo = [];
    for (const el of pendingZero) {
      if (!el.isConnected) { pendingZero.delete(el); continue; }
      const r = el.getBoundingClientRect();
      if (r.width * r.height > 0) { pendingZero.delete(el); seen.delete(el); redo.push(el); }
    }
    if (redo.length) examine(redo);
  }
  setInterval(recheckPending, 400);
  let origFrameBg = null; // 用来估计背景亮度（字体颜色的层级需要）
  const depthOf = (el) => { let d = 0; for (let n = el; n && n.parentElement && d < 8; n = n.parentElement) d++; return d; };
  function examine(list) {
    const html = document.documentElement, body = document.body;
    if (!html || !body) return;
    const jobs = [];
    for (const el of list) {
      if (!el || el.nodeType !== 1 || seen.has(el)) continue;
      seen.add(el);
      if (el instanceof SVGElement) continue;
      if (el.closest && el.closest(UI)) continue;
      const cs = getComputedStyle(el);
      const bg = cs.backgroundColor, bi = cs.backgroundImage, sh = cs.boxShadow;
      const hasBg = !isTransparent(bg), hasGrad = !!bi && bi.includes('gradient('), hasShadow = !!sh && sh !== 'none';
      let sides = null;
      for (const s of ['Top', 'Right', 'Bottom', 'Left']) {
        if (parseFloat(cs['border' + s + 'Width']) > 0 && cs['border' + s + 'Style'] !== 'none' && !isTransparent(cs['border' + s + 'Color'])) { (sides || (sides = {}))[s] = cs['border' + s + 'Color']; }
      }
      const pseudoCandidate = depthOf(el) <= 6; // 窗口底色层之类的伪元素只出现在外层容器上
      if (!(hasBg || hasGrad || hasShadow || sides || pseudoCandidate)) continue;
      jobs.push({ el, pos: cs.position, bg: hasBg ? bg : null, bi: hasGrad ? bi : null, sh: hasShadow ? sh : null, sides, pseudo: pseudoCandidate, isCard: !!(el.matches && el.matches(CARD_SEL)) });
    }
    // 第二阶段：读尺寸（和上面的样式读取在同一批里，中间没有写入，不会反复触发布局）
    const writes = [];
    for (const j of jobs) {
      const isRoot = j.el === html || j.el === body;
      const r = j.el.getBoundingClientRect();
      const forced = !isRoot && j.el.matches && j.el.matches(FORCE_SEL); // 渐隐遮罩之类：不管面积多小都要跟窗口透明度走
      const big = isRoot || forced || r.width * r.height >= MIN_AREA;
      if (!big) {
        const ar = r.width * r.height;
        if (ar === 0) pendingZero.add(j.el);                          // 还没布局出尺寸：稍后重查
        else if (j.bg && ar >= GROUP_MIN_AREA) groupMark(j.el, j.bg, j.sides); // 小元素（行内代码、徽标、弹出菜单里的块…）：按「原底色」分组，由样式表规则统一控制
        continue;
      }
      if (j.bg) writes.push({ el: j.el, kind: 'bg', c: parseColor(j.bg), root: isRoot, area: r.width * r.height, card: j.isCard, abs: j.pos === 'fixed' || j.pos === 'absolute' });
      if (j.bi) writes.push({ el: j.el, kind: 'img', t: colorTemplate(j.bi) });
      if (!isRoot && !j.isCard) {
        if (j.sides) writes.push({ el: j.el, kind: 'bd', sides: Object.fromEntries(Object.entries(j.sides).map(([s, c]) => [s, parseColor(c)])) });
        if (j.sh) writes.push({ el: j.el, kind: 'sh', t: colorTemplate(j.sh) });
      }
      if (j.pseudo && !isRoot) {
        for (const [ps, key] of [['::before', 'pb'], ['::after', 'pa']]) {
          const pc = getComputedStyle(j.el, ps);
          if (pc.content !== 'none' && !isTransparent(pc.backgroundColor)) writes.push({ el: j.el, kind: key, c: parseColor(pc.backgroundColor) });
        }
      }
    }
    const k = S.opacity / 100;
    for (const w of writes) {
      let fn;
      if (w.kind === 'bg') {
        const c = w.c, root = w.root;
        // 线性透明度：任何层（frame/侧边栏/中间栏/根容器/输入框卡片…）如果和它上面最近的「有底色的祖先」颜色相近，
        // 就只让祖先带 alpha，自己在 <100% 时透明（100% 时恢复原色，和原版一样），避免多层各乘 k 叠加成 1-(1-k)^n
        let redundant = false;
        if (!root && !w.card && !w.abs && c[3] >= 0.95) { // 悬浮的菜单/弹窗（fixed/absolute）盖在别的内容上，不能当「同色冗余层」透明掉
          for (let n = w.el.parentElement; n; n = n.parentElement) {
            const a = bgOf.get(n);
            if (a) { redundant = a[3] >= 0.95 && colorNear(a, c); break; }
          }
        }
        if (root || w.area >= MIN_AREA) bgOf.set(w.el, c);
        fn = w.card ? (kk) => w.el.style.setProperty('background-color', rgbaStr(c, kk * 0.4), 'important') // 输入框卡片底色再淡一层（只有 40% 的窗口透明度）
          : redundant
          ? (kk) => w.el.style.setProperty('background-color', rgbaStr(c, kk >= 0.999 ? 1 : 0), 'important')
          : (kk) => w.el.style.setProperty('background-color', rgbaStr(c, kk, root), 'important');
        if (w.el.matches && w.el.matches(SEL.frame) && !origFrameBg) origFrameBg = c;
        if (w.el === body && !origFrameBg) origFrameBg = c;
      } else if (w.kind === 'img') {
        const t = w.t;
        // 渐隐遮罩（输入区上方的白色渐变、侧边栏列表底部渐隐）：它们叠在已经带 alpha 的底色上，再乘 k 会让下面一大片变成 1-(1-k)^2，
        // 所以 <100% 时让它们透明，100% 恢复原样
        const fade = w.el.matches && w.el.matches(FORCE_SEL);
        fn = fade ? (kk) => w.el.style.setProperty('background-image', t(kk >= 0.999 ? 1 : 0), 'important')
                  : (kk) => w.el.style.setProperty('background-image', t(kk), 'important');
      }
      else if (w.kind === 'sh') { const t = w.t; fn = (kk) => w.el.style.setProperty('box-shadow', t(kk), 'important'); }
      else if (w.kind === 'bd') {
        // 边框跟「文字透明度」走（不是窗口透明度）；在聊天区/标题栏等已经被整块 opacity 影响的元素里，边框保持原色，免得乘两次
        const sd = w.sides, inside = !!(w.el.closest && w.el.closest(OPACITY_SEL));
        fn = () => { const tt = inside ? 1 : S.textFade / 100; for (const s in sd) w.el.style.setProperty('border-' + s.toLowerCase() + '-color', rgbaStr(sd[s], tt), 'important'); };
        if (!inside) bdList.push({ el: w.el, fn });
      }
      else if (w.kind === 'pb' || w.kind === 'pa') {
        const c = w.c, prop = '--bz-' + w.kind;
        w.el.setAttribute('data-bz-' + w.kind, '');
        fn = (kk) => w.el.style.setProperty(prop, rgbaStr(c, kk));
      }
      entries.push({ el: w.el, kind: w.kind, fn });
      fn(k);
    }
    // html 自身若原本透明，也要有底层 alpha
    if (!html.__bzFloor) { html.__bzFloor = true; if (isTransparent(getComputedStyle(html).backgroundColor)) html.style.setProperty('background-color', 'rgba(0,0,0,' + FLOOR + ')', 'important'); }
  }
  // ---------- 小元素分组：同一种「原底色」共用一条样式表规则（[data-bz-g="N"]），拖滑块只改几条规则，不逐元素写 style ----------
  // 新出现的元素（流式输出、弹出菜单、tooltip）只在被扫描到时打一次 data-bz-g 标记，之后样式表自动覆盖。
  const GROUP_MIN_AREA = 64;   // css px²：2×2 的分隔点、4×4 的状态点是「文字性」图形，不参与
  const groups = new Map();    // key -> { id, c, bd, rule }
  let groupSheet = null, groupSeq = 0, chipRules = [];
  let bdList = [];             // 「文字透明度」要联动的边框（不在 opacity 目标里的大元素）
  function getGroupSheet() {
    if (groupSheet && groupSheet.ownerNode && groupSheet.ownerNode.isConnected) return groupSheet;
    const st = document.createElement('style'); st.id = 'bz-groups';
    (document.head || document.documentElement).appendChild(st);
    groupSheet = st.sheet; groups.clear(); chipRules = [];
    // 行内代码：窗口透明度低时背景没了，靠描边区分（<100% 时描边变明显）。深/浅主题各一条
    for (const [theme, rgb] of [['light', '0,0,0'], ['dark', '255,255,255']]) {
      const i = groupSheet.insertRule('html[data-bz-theme="' + theme + '"] code:not(pre code){}', groupSheet.cssRules.length);
      chipRules.push({ rule: groupSheet.cssRules[i], rgb });
    }
    updateChip(S.opacity / 100);
    return groupSheet;
  }
  function updateChip(k) {
    if (k >= 0.999) { for (const c of chipRules) c.rule.style.removeProperty('border-color'); return; }
    for (const c of chipRules) c.rule.style.setProperty('border-color', 'rgba(' + c.rgb + ',' + (0.05 + 0.3 * (1 - k)).toFixed(3) + ')', 'important');
  }
  function updateGroup(g, k, t) {
    const st = g.rule.style;
    if (g.c) st.setProperty('background-color', rgbaStr(g.c, k), 'important');
    if (g.bd) st.setProperty('border-color', rgbaStr(g.bd, t), 'important');
  }
  function groupMark(el, bgStr, sides) {
    const c = parseColor(bgStr);
    if (!(c[3] > 0)) return;
    if (Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) > 100) return; // 饱和度很高的（红点、蓝/红实心徽标和按钮）保持原样；浅色的 mark 高亮、淡蓝气泡等照常处理
    if (el.tagName === 'BUTTON' && /_primary/.test(el.className)) return;
    let bd = null;
    // 边框：只处理「不在文字透明度作用范围内」的元素（弹出菜单/tooltip 等）；聊天区里的边框已经随整块 opacity 一起变淡，不能再乘一次
    if (sides && !(el.closest && el.closest(OPACITY_SEL))) { const cols = Object.values(sides); if (cols.every((x) => x === cols[0])) bd = parseColor(cols[0]); }
    const sheet = getGroupSheet();
    const key = c.join(',') + '|' + (bd ? bd.join(',') : '');
    let g = groups.get(key);
    if (!g) {
      const id = ++groupSeq;
      const i = sheet.insertRule('[data-bz-g="' + id + '"]{}', sheet.cssRules.length);
      g = { id, c, bd, rule: sheet.cssRules[i] }; groups.set(key, g);
      updateGroup(g, S.opacity / 100, S.textFade / 100);
    }
    el.setAttribute('data-bz-g', String(g.id));
  }
  function applyGroupsBg() { const k = S.opacity / 100, t = S.textFade / 100; for (const g of groups.values()) updateGroup(g, k, t); updateChip(k); }
  function resetGroups() {
    document.querySelectorAll('[data-bz-g]').forEach((e) => e.removeAttribute('data-bz-g'));
    const n = groupSheet && groupSheet.ownerNode; if (n) n.remove();
    groupSheet = null; groups.clear(); chipRules = [];
  }
  function applyBg() {
    const k = S.opacity / 100;
    applyGroupsBg();
    let dead = 0;
    for (const e of entries) { if (e.el.isConnected) e.fn(k); else dead++; }
    if (dead > 40) entries = entries.filter((e) => e.el.isConnected);
  }
  function resetBg() {
    for (const e of entries) {
      const st = e.el.style;
      if (e.kind === 'bg') st.removeProperty('background-color');
      else if (e.kind === 'img') st.removeProperty('background-image');
      else if (e.kind === 'sh') st.removeProperty('box-shadow');
      else if (e.kind === 'bd') ['top', 'right', 'bottom', 'left'].forEach((s) => st.removeProperty('border-' + s + '-color'));
      else if (e.kind === 'pb' || e.kind === 'pa') { st.removeProperty('--bz-' + e.kind); e.el.removeAttribute('data-bz-' + e.kind); }
    }
    entries = []; bdList = [];
    resetGroups();
    const html = document.documentElement; if (html) { html.style.removeProperty('background-color'); html.__bzFloor = false; }
  }

  // ---------- 文字透明度：约 10 个目标元素自己的 opacity（卡片只设 --bz-t，用于边框/阴影） ----------
  let opTargets = [], cardTargets = [];
  let targetSeen = new WeakSet();
  function registerTargets(node) {
    if (!node || node.nodeType !== 1) return;
    const add = (el) => {
      if (targetSeen.has(el)) return; targetSeen.add(el);
      if (el.matches(CARD_SEL)) cardTargets.push(el);
      if (el.matches(OPACITY_SEL)) opTargets.push(el);
    };
    if (node.matches(TARGET_SEL)) add(node);
    if (node.firstElementChild) node.querySelectorAll(TARGET_SEL).forEach(add);
  }
  function applyText() {
    const t = S.textFade / 100;
    const v = String(t);
    let dead = 0;
    for (const el of opTargets) { if (el.isConnected) el.style.opacity = v; else dead++; }
    for (const el of cardTargets) { if (el.isConnected) el.style.setProperty('--bz-t', v); else dead++; }
    if (dead > 10) { opTargets = opTargets.filter((e) => e.isConnected); cardTargets = cardTargets.filter((e) => e.isConnected); }
    if (groups.size) { const k = S.opacity / 100; for (const g of groups.values()) if (g.bd) updateGroup(g, k, t); }
    for (const e of bdList) if (e.el.isConnected) e.fn();
  }
  function resetText() {
    for (const el of opTargets) el.style.removeProperty('opacity');
    for (const el of cardTargets) el.style.removeProperty('--bz-t');
    opTargets = []; cardTargets = [];
  }

  // ---------- 增量扫描：只处理新增节点，rAF 里按时间预算分批（流式输出时不会卡） ----------
  let queue = [], queued = new Set(), pumpScheduled = false;
  function enqueue(node) {
    if (node.nodeType !== 1 || queued.has(node)) return;
    queued.add(node); queue.push(node);
    if (!pumpScheduled) { pumpScheduled = true; raf(pump); }
  }
  function pump() {
    pumpScheduled = false;
    const t0 = performance.now();
    while (queue.length && performance.now() - t0 < 5) {
      const batch = queue.splice(0, 200);
      const els = [];
      for (const n of batch) {
        queued.delete(n);
        if (!n.isConnected) continue;
        registerTargets(n);
        els.push(n);
        if (n.firstElementChild) { const all = n.getElementsByTagName('*'); for (let i = 0; i < all.length && i < 3000; i++) els.push(all[i]); }
      }
      examine(els);
      if (S.textFade !== 100) applyText();
    }
    if (queue.length) { pumpScheduled = true; raf(pump); }
    ensureButton();
  }
  let mo = null;
  function startObserver() {
    mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (!m.addedNodes.length) continue;
        const tgt = m.target;
        if (tgt.nodeType === 1 && tgt.closest && tgt.closest(UI)) continue;
        for (const n of m.addedNodes) { if (n.nodeType === 1 && !(n.id && n.id.startsWith('bz-'))) enqueue(n); }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true }); // 只看新增/删除节点，不看属性和文本变化
  }
  function fullScan() {
    registerTargets(document.documentElement);
    const all = document.getElementsByTagName('*'); const arr = [];
    for (let i = 0; i < all.length; i++) arr.push(all[i]);
    // 分批：每帧最多处理一块，避免首屏一次性长任务
    const chunk = () => { examine(arr.splice(0, 600)); if (arr.length) raf(chunk); };
    chunk();
  }
  function rescanAll() {
    resetBg(); resetText(); queue = []; queued.clear();
    seen = new WeakSet(); targetSeen = new WeakSet(); bgOf = new WeakMap(); pendingZero.clear();
    fullScan(); applyText();
  }

  // ---------- 蓝色高亮 -> 灰色（主题里的蓝色 CSS 变量） ----------
  let accentStyle = null;
  const accentDecl = new Map();
  const blueish = (c) => c[3] > 0 && c[2] > 150 && c[2] - c[0] > 60 && c[1] >= c[0] - 10;
  function collectVarNames(rules, names, re) {
    for (const rule of rules) {
      if (rule.style) for (const n of rule.style) if (n.startsWith('--') && (!re || re.test(n))) names.add(n);
      if (rule.cssRules) collectVarNames(rule.cssRules, names, re);
    }
  }
  const ACCENT_RE = /blue|deepseek|brand|info|link|business|accent|selection|deep-diving|primary-new/i;
  function probeVars(names, probe) {
    const out = [];
    for (const n of names) {
      probe.style.color = ''; probe.style.color = 'var(' + n + ')';
      const cc = getComputedStyle(probe).color;
      if (cc) out.push([n, parseColor(cc)]);
    }
    return out;
  }
  function grayAccents() {
    const names = new Set();
    for (const ss of document.styleSheets) { try { collectVarNames(ss.cssRules, names, ACCENT_RE); } catch (e) {} }
    if (!names.size || !document.body) return;
    const probe = document.createElement('span');
    probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none';
    document.body.appendChild(probe);
    for (const [n, c] of probeVars(names, probe)) {
      if (n.startsWith('--bz') || n.startsWith('--shiki')) continue;
      if (blueish(c)) { const g = Math.max(120, Math.min(190, Math.round(lum(c[0], c[1], c[2]) * 255))); accentDecl.set(n, 'rgb(' + g + ' ' + g + ' ' + g + ' / ' + (+c[3].toFixed(3)) + ')'); }
    }
    probe.remove();
    if (!accentStyle) { accentStyle = document.createElement('style'); accentStyle.id = 'bz-accent'; (document.head || document.documentElement).appendChild(accentStyle); }
    accentStyle.textContent = accentDecl.size ? '*, *::before, *::after {' + [...accentDecl].map(([k, v]) => k + ':' + v + ' !important;').join('') + '}' : '';
  }

  // ---------- 主题（深/浅）----------
  function updateTheme() {
    // 以前按 body 文字颜色判断，深色主题下 body 的 color 根本不变（实测），所以判断错。改成：应用显式选了深/浅就用它，否则（跟随系统）看 prefers-color-scheme
    const h = document.documentElement;
    const src = h.getAttribute('data-ds-theme') || h.getAttribute('data-ds-theme-source') || h.getAttribute('data-theme');
    const dark = src === 'dark' ? true : src === 'light' ? false : window.matchMedia('(prefers-color-scheme: dark)').matches;
    h.setAttribute('data-bz-theme', dark ? 'dark' : 'light');
  }

  // ---------- 字体颜色：覆盖 --dsw-alias-label-* 这几级文字颜色变量，只用根上的一个 --bz-rgb ----------
  // 保持层级：次要/三级/说明文字 = 同一个颜色，但 alpha 按「它和主文字相对背景的对比度」缩小；透明度滑块（opacity）仍然单独叠加。
  const LABEL_VARS = ['--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary', '--dsw-alias-label-caption', '--dsw-alias-label-document-preview', '--dsw-alias-label-dimmed', '--dsw-alias-brand-text'];
  const BORDER_VARS = ['--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-border-l3', '--dsw-alias-border-l4', '--dsw-alias-settings-card-stroke', '--dsw-elevation-stroke-color'];
  const ICON_VARS = ['--dsw-alias-menu-icon'];
  let colorStyle = null, colorKey = '';
  function buildColorCss() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none';
    document.body.appendChild(probe);
    if (colorStyle) colorStyle.disabled = true; // 读取「原始值」时先停掉我们自己的覆盖
    const orig = new Map(probeVars([...LABEL_VARS, ...BORDER_VARS, ...ICON_VARS], probe));
    if (colorStyle) colorStyle.disabled = false;
    probe.remove();
    const dark = document.documentElement.getAttribute('data-bz-theme') === 'dark';
    const bgc = origFrameBg || (dark ? [24, 24, 28, 1] : [249, 250, 251, 1]);
    const Lbg = lum(bgc[0], bgc[1], bgc[2]);
    const prim = orig.get('--dsw-alias-label-primary') || (dark ? [249, 250, 251, 1] : [15, 17, 21, 1]);
    const base = Math.max(0.2, Math.abs(lum(prim[0], prim[1], prim[2]) - Lbg));
    const factor = (c) => Math.max(0.12, Math.min(1, (Math.abs(lum(c[0], c[1], c[2]) - Lbg) / base) * c[3]));
    const decl = [];
    for (const n of LABEL_VARS) { const c = orig.get(n); if (c) decl.push(n + ':rgb(var(--bz-rgb) / ' + (n === '--dsw-alias-label-primary' || n === '--dsw-alias-brand-text' ? 1 : +factor(c).toFixed(3)) + ') !important;'); }
    let extra = '';
    if (S.colorIcons) {
      for (const n of ICON_VARS) { const c = orig.get(n); if (c) decl.push(n + ':rgb(var(--bz-rgb) / ' + (+factor(c).toFixed(3)) + ') !important;'); }
      for (const n of BORDER_VARS) { const c = orig.get(n); if (c && c[3] > 0) decl.push(n + ':rgb(var(--bz-rgb) / ' + (+c[3].toFixed(3)) + ') !important;'); }
      extra = SEL.composer + ' button[class*="_primary"] { background-color: rgb(var(--bz-rgb) / .6) !important; color: ' + (lum(...hexToRgb(S.textColor)) > 0.6 ? '#111' : '#fff') + ' !important; }';
    } else {
      // 图标和按钮保持灰色（程序原来的次要文字灰）
      const sec = orig.get('--dsw-alias-label-secondary') || [97, 102, 107, 1];
      extra = 'svg { color: rgb(' + sec[0] + ' ' + sec[1] + ' ' + sec[2] + ') !important; } #bz-wc { color: rgb(' + sec[0] + ' ' + sec[1] + ' ' + sec[2] + ') !important; }';
    }
    return '*, *::before, *::after {' + decl.join('') + '}' + extra;
  }
  function applyColor() {
    const html = document.documentElement; if (!html) return;
    if (!hexOk(S.textColor)) {
      if (colorStyle) { colorStyle.remove(); colorStyle = null; colorKey = ''; }
      html.style.removeProperty('--bz-rgb'); html.removeAttribute('data-bz-tc'); html.removeAttribute('data-bz-ci');
      return;
    }
    const rgb = hexToRgb(S.textColor);
    html.style.setProperty('--bz-rgb', rgb[0] + ' ' + rgb[1] + ' ' + rgb[2]);
    html.setAttribute('data-bz-tc', ''); if (S.colorIcons) html.setAttribute('data-bz-ci', ''); else html.removeAttribute('data-bz-ci');
    const key = (S.colorIcons ? 'i' : 'n') + (html.getAttribute('data-bz-theme') || '');
    if (!colorStyle || colorKey !== key) {
      if (!document.body) return; // body 还没出现，boot 之后会再调用
      const text = buildColorCss();
      if (!colorStyle) { colorStyle = document.createElement('style'); colorStyle.id = 'bz-color'; (document.head || html).appendChild(colorStyle); }
      colorStyle.textContent = text; colorKey = key;
    }
  }

  // ---------- 极简/魔术类名 ----------
  let focused = true, wakeTimer = null;
  const isAway = () => !!S.magic && !focused;
  function applyClasses() {
    const root = document.documentElement; if (!root) return;
    root.classList.toggle('bz-min', !!S.minimal);
    root.classList.toggle('bz-away', isAway());
    if (isAway()) closeMenu();
    if (!S.magic) endWake();
  }

  // ---------- 侧边栏「皮肤设置」按钮：克隆原生 panelRow 的样式 ----------
  let btn = null;
  function ensureButton() {
    const host = document.querySelector(SEL.footerActions);
    const ref = document.querySelector(SEL.panelRow);
    if (!host || !ref) return;
    if (btn && btn.isConnected && host.contains(btn)) return;
    const glyph = ref.querySelector('[class*="_panelGlyph"]');
    const title = ref.querySelector('[class*="_panelTitle"]');
    btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'bz-btn';
    btn.className = ref.className;
    btn.setAttribute('aria-label', '皮肤设置');
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.innerHTML = '<span class="' + (glyph ? glyph.className : '') + '" aria-hidden="true"><svg width="16" height="16" aria-hidden="true"><use href="#dsw-icon-sliders-two-outline-regular"></use></svg></span><span class="' + (title ? title.className : '') + '">皮肤设置</span>';
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(btn); });
    host.appendChild(btn);
  }

  // ---------- 弹出菜单 + 字体颜色调色盘 ----------
  let menu = null, menuOpen = false, palOpen = false, isPanel = false;
  const SWATCHES = [['白', '#ffffff'], ['浅灰', '#d8dbe0'], ['灰', '#9aa0a8'], ['黑', '#1a1c20'], ['薄荷绿', '#a0e8c0'], ['淡蓝', '#a8d0f0'], ['淡紫', '#c8b8f0'], ['暖黄', '#f0dca0'], ['粉', '#f4b8cc']];
  let hsv = [150, 0.3, 0.9];
  function buildMenu() {
    menu = document.createElement('div');
    menu.id = 'bz-menu';
    menu.hidden = true;
    menu.setAttribute('role', 'dialog');
    menu.innerHTML = `
      <div class="bz-ttl">皮肤设置</div>
      <div class="bz-r"><label><span>窗口透明度</span><b data-v="opacity"></b></label><input type="range" min="0" max="100" data-k="opacity"></div>
      <div class="bz-r"><label><span>文字透明度</span><b data-v="textFade"></b></label><input type="range" min="0" max="100" data-k="textFade"></div>
      <div class="bz-colorrow" data-a="pal"><span>字体颜色</span><button type="button" class="bz-dot" data-a="pal" title="字体颜色"></button></div>
      <div class="bz-pal" hidden>
        <div class="bz-sw">${SWATCHES.map(([n, c]) => '<button type="button" title="' + n + '" data-c="' + c + '" style="background:' + c + '"></button>').join('')}</div>
        <div class="bz-sv"><div class="bz-svp"></div></div>
        <div class="bz-hue"><div class="bz-huep"></div></div>
        <div class="bz-hexrow"><input class="bz-hex" spellcheck="false" maxlength="7" placeholder="#A0E8C0"><button type="button" class="bz-b" data-a="default">默认</button></div>
        <label class="bz-c"><input type="checkbox" data-k="colorIcons"><span>图标和按钮也跟随字体颜色</span></label>
      </div>
      <label class="bz-c"><input type="checkbox" data-k="minimal"><span>极简模式</span></label>
      <label class="bz-c"><input type="checkbox" data-k="magic"><span>魔术模式（点别的窗口自动隐形）</span></label>
      <button type="button" class="bz-b" data-a="reset">恢复原样</button>
      <div class="bz-k">Ctrl+Alt+T 设置 · Ctrl+Alt+M 魔术 · Ctrl+Alt+0 恢复</div>`;
    document.body.appendChild(menu);
    menu.querySelectorAll('[data-k]').forEach((el) => {
      el.addEventListener('input', () => set({ [el.dataset.k]: el.type === 'checkbox' ? el.checked : +el.value }));
    });
    menu.querySelector('[data-a=reset]').onclick = () => call({ type: 'reset' });
    menu.querySelector('.bz-colorrow').addEventListener('click', () => { palOpen = !palOpen; syncMenu(); placeMenu(btn); if (isPanel) menu.scrollTop = menu.scrollHeight; });
    menu.querySelector('[data-a=default]').onclick = () => { set({ textColor: '' }); syncMenu(); };
    menu.querySelectorAll('.bz-sw button').forEach((b) => b.addEventListener('click', () => { setColor(b.dataset.c, true); }));
    const hexIn = menu.querySelector('.bz-hex');
    hexIn.addEventListener('input', () => { let v = hexIn.value.trim(); if (v && v[0] !== '#') v = '#' + v; if (hexOk(v)) setColor(v.toLowerCase(), false, true); });
    // 饱和度/亮度方块 + 色相条（pointer 事件，拖动时实时预览；更新由 rAF 合并）
    const drag = (el, onMove) => {
      el.addEventListener('pointerdown', (e) => {
        el.setPointerCapture(e.pointerId); dragging++; onMove(e);
        const mv = (ev) => onMove(ev);
        const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); dragging = Math.max(0, dragging - 1); };
        el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
      });
    };
    const sv = menu.querySelector('.bz-sv'), hue = menu.querySelector('.bz-hue');
    drag(sv, (e) => { const r = sv.getBoundingClientRect(); hsv[1] = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); hsv[2] = 1 - Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)); fromHsv(); });
    drag(hue, (e) => { const r = hue.getBoundingClientRect(); hsv[0] = Math.max(0, Math.min(359.99, ((e.clientX - r.left) / r.width) * 360)); fromHsv(); });
  }
  function fromHsv() { const [r, g, b] = hsvToRgb(hsv[0], hsv[1], hsv[2]); setColor(rgbToHex(r, g, b), false, false, true); }
  let colorRaf = 0, colorPending = null, lastColorAt = 0;
  function setColor(hex, fromSwatch, fromHex, fromPicker) {
    if (!fromPicker && !fromHex) { const [h, s, v] = rgbToHsv(...hexToRgb(hex)); hsv = [s < 0.02 ? hsv[0] : h, s, v]; }
    if (fromHex) { const [h, s, v] = rgbToHsv(...hexToRgb(hex)); hsv = [s < 0.02 ? hsv[0] : h, s, v]; }
    colorPending = hex;
    if (colorRaf) return;
    // 整棵树只重算一次/帧；拖动时限频到约 30Hz
    colorRaf = raf(function tick() {
      const now = performance.now();
      if (now - lastColorAt < 30 && fromPicker) { colorRaf = raf(tick); return; }
      colorRaf = 0; lastColorAt = now;
      const h = colorPending; colorPending = null;
      if (h) set({ textColor: h });
    });
  }
  // 只改文本节点的 data（不改子节点列表）：实测 textContent（增删子节点）会触发约 15ms 的全树样式重算，拖动时会掉到 30fps
  function setText(el, str) {
    let n = el.firstChild;
    if (!n || n.nodeType !== 3) { el.textContent = ''; n = el.appendChild(document.createTextNode('')); }
    if (n.data !== str) n.data = str;
  }
  function syncMenu() {
    if (!menu) return;
    for (const k of ['opacity', 'textFade', 'minimal', 'magic', 'colorIcons']) {
      const el = menu.querySelector('[data-k=' + k + ']');
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!S[k]; else if (document.activeElement !== el) el.value = S[k];
      const v = menu.querySelector('[data-v=' + k + ']'); if (v) setText(v, S[k] + '%');
    }
    const dot = menu.querySelector('.bz-dot');
    const has = hexOk(S.textColor);
    dot.style.background = has ? S.textColor : 'transparent';
    setText(dot, has ? '' : 'A');
    menu.querySelector('.bz-pal').hidden = !palOpen;
    if (palOpen) {
      const [h, s, v] = hexOk(S.textColor) && !dragging ? rgbToHsv(...hexToRgb(S.textColor)) : hsv;
      if (!dragging && hexOk(S.textColor) && s >= 0.02) hsv = [h, s, v]; else if (!dragging && hexOk(S.textColor)) hsv = [hsv[0], s, v];
      const svEl = menu.querySelector('.bz-sv');
      svEl.style.background = 'linear-gradient(to top,#000,rgba(0,0,0,0)),linear-gradient(to right,#fff,hsl(' + hsv[0] + ',100%,50%))';
      const p = menu.querySelector('.bz-svp'); p.style.left = (hsv[1] * 100) + '%'; p.style.top = ((1 - hsv[2]) * 100) + '%';
      menu.querySelector('.bz-huep').style.left = (hsv[0] / 360 * 100) + '%';
      const hexIn = menu.querySelector('.bz-hex');
      if (document.activeElement !== hexIn) hexIn.value = hexOk(S.textColor) ? S.textColor.toUpperCase() : '';
    }
  }
  function placeMenu(anchor) {
    if (!menu || isPanel) return;
    // 宽度 = min(264, 窗口宽 − 16)（CSS 的 max-width 也限制）；高度超出窗口时菜单内部滚动；位置夹在窗口内
    const vis = anchor && anchor.isConnected && anchor.getBoundingClientRect().width > 0;
    const maxW = Math.max(120, innerWidth - 16);
    menu.style.maxHeight = Math.max(80, innerHeight - 16) + 'px';
    const w = Math.min(292, maxW), h = menu.offsetHeight || 300;
    let left, bottomEdge;
    if (vis) { const r = anchor.getBoundingClientRect(); left = r.left; bottomEdge = r.top - 8; }
    else { left = 16; bottomEdge = innerHeight - 16; } // 极简模式：侧边栏被隐藏，弹在窗口左下角
    left = Math.max(8, Math.min(left, innerWidth - w - 8));
    const top = Math.max(8, Math.min(bottomEdge - h, innerHeight - h - 8));
    menu.style.left = left + 'px'; menu.style.top = top + 'px'; menu.style.bottom = 'auto';
  }
  const isDarkNow = () => { const c = getComputedStyle(document.body).color.match(/[\d.]+/g) || [0, 0, 0]; return lum(+c[0], +c[1], +c[2]) > 0.6; }; // 文字偏亮说明是深色主题
  function openMenu(anchor) {
    if (!document.body) return;
    if (!isPanel && (innerWidth < 260 || innerHeight < 300)) { closeMenu(); call({ type: 'panel', dark: isDarkNow() }); return; } // 窗口太小：弹独立设置窗口
    if (!menu) buildMenu();
    menu.classList.toggle('bz-dark', isDarkNow());
    menu.hidden = false;
    menuOpen = true;
    syncMenu();
    placeMenu(anchor || btn);
  }
  function closeMenu() { if (menu) menu.hidden = true; menuOpen = false; }
  function toggleMenu(anchor) { menuOpen ? closeMenu() : openMenu(anchor); }
  const onDocDown = (e) => {
    if (!menuOpen || isPanel) return;
    if (menu && menu.contains(e.target)) return;
    if (btn && btn.contains(e.target)) return;
    closeMenu();
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    if (isPanel) { call({ type: 'panel', close: true }); return; }
    if (menuOpen) { closeMenu(); return; }
    // 极简模式没有发送/停止键：生成中按 Esc = 点原来的「停止」按钮（隐藏的按钮照样能 click）
    if (document.documentElement.classList.contains('bz-min') && !e.isComposing) {
      const b = document.querySelector(SEL.composer + ' button[class*="_primary"]');
      if (b && !/发送/.test(b.getAttribute('aria-label') || '') && !b.disabled) { b.click(); e.preventDefault(); }
    }
  };

  // ---------- 窗口按钮：自己画的最小化/最大化/关闭（极简模式没有关闭键） ----------
  let wc = null, veil = null;
  function buildChrome() {
    wc = document.createElement('div');
    wc.id = 'bz-wc';
    wc.innerHTML = '<button type="button" data-op="min" aria-label="最小化"><svg viewBox="0 0 10 10"><path d="M0 5h10"/></svg></button>' +
      '<button type="button" data-op="max" aria-label="最大化"><svg class="bz-i-max" viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9"/></svg><svg class="bz-i-res" viewBox="0 0 10 10" style="display:none"><rect x=".5" y="2.5" width="7" height="7"/><path d="M2.5 2.5V.5h7v7h-2"/></svg></button>' +
      '<button type="button" data-op="close" aria-label="关闭"><svg viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10"/></svg></button>';
    wc.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { call({ type: 'win', op: b.dataset.op }); setTimeout(updateMax, 400); } });
    document.body.appendChild(wc);
    // 极简模式：8 个隐形缩放边 + 顶部拖动条（只在 html.bz-min 下显示）
    const rs = document.createElement('div');
    rs.id = 'bz-rs';
    rs.innerHTML = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((d) => `<i data-e="${d}"></i>`).join('') + '<b id="bz-drag"></b>';
    rs.addEventListener('pointerdown', (e) => {
      const el = e.target.closest('i[data-e]'); if (!el || e.button !== 0) return;
      e.preventDefault(); el.setPointerCapture(e.pointerId);
      call({ type: 'rs', edge: el.dataset.e });
      const end = () => { call({ type: 'rs', edge: '' }); el.removeEventListener('pointerup', end); el.removeEventListener('pointercancel', end); el.removeEventListener('lostpointercapture', end); };
      el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end); el.addEventListener('lostpointercapture', end);
    });
    document.body.appendChild(rs);
    updateMax();
    // 魔术模式：veil 吞掉唤醒的那一下点击，不会触发下面的按钮/输入框
    veil = document.createElement('div');
    veil.id = 'bz-veil';
    const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
    ['pointerup', 'mouseup', 'dblclick', 'contextmenu', 'auxclick', 'wheel', 'touchstart', 'touchend'].forEach((t) => veil.addEventListener(t, swallow, { passive: false }));
    ['pointerdown', 'mousedown'].forEach((t) => veil.addEventListener(t, (e) => { swallow(e); if (document.documentElement.classList.contains('bz-wake')) { clearTimeout(wakeTimer); wakeTimer = setTimeout(endWake, 1500); } }, { passive: false }));
    veil.addEventListener('click', (e) => { swallow(e); if (document.documentElement.classList.contains('bz-wake')) endWake(); });
    document.body.appendChild(veil);
    registerTargets(wc);
  }
  const updateMax = () => {
    if (!wc) return;
    const m = innerWidth >= screen.availWidth - 2 && innerHeight >= screen.availHeight - 2;
    wc.querySelector('.bz-i-max').style.display = m ? 'none' : '';
    wc.querySelector('.bz-i-res').style.display = m ? '' : 'none';
  };
  function endWake() { clearTimeout(wakeTimer); wakeTimer = null; document.documentElement.classList.remove('bz-wake'); }
  function startWake() {
    // 焦点事件和鼠标按下事件的先后顺序不固定：恢复后让 veil 再多留一小会儿，直到这一下点击结束
    document.documentElement.classList.add('bz-wake');
    clearTimeout(wakeTimer);
    wakeTimer = setTimeout(endWake, 450);
  }

  // ---------- 对外接口（启动器 / 主进程通过 executeJavaScript 调用） ----------
  window.__bz = {
    apply(next) {
      // 拖动中或刚刚本地改过：忽略启动器回显，避免用旧值覆盖正在拖的值
      if (dragging || performance.now() - lastLocalSet < 400) return;
      const prev = S; S = Object.assign({}, DEFAULTS, next);
      for (const k in DEFAULTS) if (S[k] !== prev[k]) dirty[k] = true;
      dirty.menu = true; scheduleApply();
    },
    setFocus(v) {
      const was = isAway();
      focused = !!v;
      if (was && focused) startWake();
      dirty.magic = true; scheduleApply();
    },
    set(patch) { set(patch); }, // 和界面上的控件走同一条路径：先本地应用，再（防抖后）回传启动器
    openMenu() { openMenu(btn); },
    toggleMenu() { toggleMenu(btn); },
    closeMenu,
    panelMode(dark) { // 独立设置窗口：整窗菜单
      isPanel = true; const r = document.documentElement; r.classList.add('bz-panelwin'); r.classList.toggle('bz-pdark', !!dark);
      if (!menu) buildMenu(); menu.classList.toggle('bz-dark', !!dark); menu.hidden = false; menuOpen = true; palOpen = false; syncMenu();
    },
    rescan() { rescanAll(); },
    destroy() {
      cleanups.forEach((f) => { try { f(); } catch (e) {} });
      if (mo) mo.disconnect();
      document.removeEventListener('pointerdown', onDocDown, true); document.removeEventListener('click', onCopyClick, true); document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', updateMax); window.removeEventListener('resize', onResizeMenu); document.removeEventListener('mousedown', onDgDown, true); document.removeEventListener('mousemove', onDgMove, true); document.removeEventListener('mouseup', onDgUp, true);
      resetBg(); resetText();
      [styleEl, accentStyle, colorStyle, veil, wc, menu, btn].forEach((e) => { try { e && e.remove(); } catch (x) {} });
      const r = document.documentElement;
      if (r) { ['bz-min', 'bz-away', 'bz-wake'].forEach((x) => r.classList.remove(x)); ['data-bz-theme', 'data-bz-tc', 'data-bz-ci'].forEach((a) => r.removeAttribute(a)); r.style.removeProperty('--bz-rgb'); }
    },
  };

  // ---------- 启动顺序 ----------
  // 极简模式：点复制后短暂显示 ✓（一个委托监听，不逐元素处理）
  const onCopyClick = (e) => {
    if (!document.documentElement.classList.contains('bz-min')) return;
    const b = e.target.closest && e.target.closest('button[aria-label="复制"]'); if (!b) return;
    b.classList.add('bz-copied'); setTimeout(() => b.classList.remove('bz-copied'), 1200);
  };
  document.addEventListener('click', onCopyClick, true);
  document.addEventListener('pointerdown', onDocDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', updateMax);
  function onResizeMenu() { if (menuOpen && !isPanel) { if (innerWidth < 260 || innerHeight < 300) { closeMenu(); } else placeMenu(btn); } }
  window.addEventListener('resize', onResizeMenu);
  // ---------- 极简模式：非文字区域按住拖动窗口 ----------
  // 不用 -webkit-app-region（会吞点击/右键/选字）：mousedown 时判断目标不是交互元素、不在滚动条上、鼠标下也没有真正的文字，
  // 移动超过 3px 才通知主进程开始拖动（主进程按鼠标屏幕坐标 setBounds）；mouseup 结束。
  const NO_DRAG = 'a,button,input,textarea,select,label,summary,video,audio,canvas,img,pre,code,svg,iframe,[contenteditable],[role="button"],[role="textbox"],[role="slider"],#bz-menu,#bz-wc,#bz-rs i';
  let dg = null;
  function onScrollbar(e) {
    for (let n = e.target; n && n.nodeType === 1; n = n.parentElement) {
      const root = n === document.documentElement, cw = root ? document.documentElement.clientWidth : n.clientWidth, ow = root ? innerWidth : n.offsetWidth;
      if (ow - cw > 2) { const left = root ? 0 : n.getBoundingClientRect().left; if (e.clientX >= left + cw) return true; }
      const ch = root ? document.documentElement.clientHeight : n.clientHeight, oh = root ? innerHeight : n.offsetHeight;
      if (oh - ch > 2) { const top = root ? 0 : n.getBoundingClientRect().top; if (e.clientY >= top + ch) return true; }
    }
    return false;
  }
  function textAt(x, y) {
    const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
    if (!r || r.startContainer.nodeType !== 3) return false;
    const n = r.startContainer, o = r.startOffset, len = n.data.length;
    for (const [a, b] of [[o, o + 1], [o - 1, o]]) {
      if (a < 0 || b > len || /\s/.test(n.data.slice(a, b))) continue;
      const rg = document.createRange(); rg.setStart(n, a); rg.setEnd(n, b);
      for (const q of rg.getClientRects()) if (x >= q.left - 1 && x <= q.right + 1 && y >= q.top - 1 && y <= q.bottom + 1) return true;
    }
    return false;
  }
  function onDgDown(e) {
    dg = null;
    if (isPanel || e.button !== 0 || e.defaultPrevented || !document.documentElement.classList.contains('bz-min')) return;
    const t = e.target; if (!t || t.nodeType !== 1 || t.closest(NO_DRAG) || onScrollbar(e) || textAt(e.clientX, e.clientY)) return;
    dg = { x: e.screenX, y: e.screenY, on: false };
  }
  function onDgMove(e) {
    if (!dg || dg.on) return;
    if (!(e.buttons & 1)) { dg = null; return; }
    if (Math.hypot(e.screenX - dg.x, e.screenY - dg.y) <= 3) return;
    dg.on = true; document.documentElement.classList.add('bz-dragging');
    try { getSelection().removeAllRanges(); } catch (x) {}
    call({ type: 'dg', on: true });
  }
  function onDgUp() {
    if (dg && dg.on) { call({ type: 'dg', on: false }); document.documentElement.classList.remove('bz-dragging'); }
    dg = null;
  }
  document.addEventListener('mousedown', onDgDown, true);
  document.addEventListener('mousemove', onDgMove, true);
  document.addEventListener('mouseup', onDgUp, true);
  window.addEventListener('blur', onDgUp);
  whenRoot(() => {
    injectStyle();                 // 根元素一出现就插入静态样式（发送按钮灰色等不会先闪出原样）
    applyClasses();
    if (hexOk(S.textColor)) applyColor();
  });
  whenBody(() => {
    buildChrome();
    startObserver();
    // 样式表加载完之后再做：灰色蓝色变量、主题判断、首次全量扫描
    whenReady(() => {
      grayAccents(); updateTheme();
      fullScan(); applyText(); applyClasses(); applyColor(); ensureButton();
      call({ type: 'hello' });
    });
  });
  // 主题（深/浅）切换后原始颜色变了：重新采集（很少发生）
  whenBody(() => {
    // 深/浅主题切换后，原来记下的字面 rgba 背景色全是旧主题的 → 必须重新扫描
    let themeTimer = 0, themeTimer2 = 0;
    const onTheme = () => {
      const before = document.documentElement.getAttribute('data-bz-theme');
      updateTheme(); grayAccents(); colorKey = ''; applyColor();
      if (before !== document.documentElement.getAttribute('data-bz-theme')) { clearTimeout(themeTimer); clearTimeout(themeTimer2); themeTimer = setTimeout(rescanAll, 150); themeTimer2 = setTimeout(rescanAll, 900); } // 应用自己换主题色有延迟，再补扫一次
    };
    const themeMo = new MutationObserver(onTheme);
    themeMo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-ds-theme', 'data-ds-theme-source', 'data-theme'] });
    cleanups.push(() => themeMo.disconnect());
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onScheme = onTheme;
    mq.addEventListener('change', onScheme);
    cleanups.push(() => mq.removeEventListener('change', onScheme));
  });
})();
