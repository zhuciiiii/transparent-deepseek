// 在 Harness 主进程里、main.js 执行之前，由启动器通过 --inspect-brk 的调试连接 Runtime.evaluate 执行。
// BrowserWindow 是原生构造函数、electron 的 ESM 导出又不可替换，所以不包装类，改走「选项读取」：
// 原生代码读取 new BrowserWindow(options) 的 options.transparent / options.backgroundColor 时是沿原型链取值的，
// 因此在 Object.prototype 上放受限 getter：只对「带 titleBarOverlay 的主窗口选项对象」且调用栈在 createWindow 内时，
// 返回 transparent:true / backgroundColor:#00000000，其它任何对象一律返回 undefined（setter 保证正常赋值不受影响）。
// 不修改任何程序文件。
(() => {
  if (globalThis.__bzHooked) return 'already';
  globalThis.__bzHooked = true;
  const fs = process.getBuiltinModule('node:fs');
  const M = process.getBuiltinModule('node:module');
  const LOG = __BZ_LOG__;
  const log = (...a) => {
    try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n'); } catch (e) {}
  };
  const TRANSPARENT = '#00000000';
  const mainSet = new WeakSet();
  const isMainOpts = (o) => {
    try {
      if (mainSet.has(o)) return true;
      if (!o || typeof o !== 'object' || !Object.prototype.hasOwnProperty.call(o, 'titleBarOverlay')) return false;
      if (!/\bcreateWindow\b/.test(new Error().stack || '')) return false;
      mainSet.add(o);
      return true;
    } catch (e) { return false; }
  };
  // 原生的最小化/最大化/关闭按钮（titleBarOverlay）的点击区不能缩小/关闭，隐形和极简模式下会误触；
  // 所以创建窗口时把 titleBarOverlay 去掉，由页面自己画这三个按钮（页面里隐形时由 veil 接管点击）。
  globalThis.__bzSelfButtons = true;
  const seen = new WeakSet();
  const define = (name, value) => {
    Object.defineProperty(Object.prototype, name, {
      configurable: true,
      enumerable: false,
      get() {
        if (isMainOpts(this)) {
          if (!seen.has(this)) {
            seen.add(this);
            log('main window options (before):', {
              ownTransparent: Object.prototype.hasOwnProperty.call(this, 'transparent'),
              ownBackgroundColor: Object.prototype.hasOwnProperty.call(this, 'backgroundColor'),
              frame: this.frame, titleBarStyle: this.titleBarStyle, titleBarOverlay: this.titleBarOverlay,
              backgroundMaterial: this.backgroundMaterial, thickFrame: this.thickFrame, hasShadow: this.hasShadow,
              resizable: this.resizable, width: this.width, height: this.height,
            });
            log('-> forcing transparent:true + backgroundColor ' + TRANSPARENT);
            if (globalThis.__bzSelfButtons) {
              try { delete this.titleBarOverlay; log('-> titleBarOverlay removed; window buttons are drawn by the page'); } catch (e) { log('remove titleBarOverlay failed', String(e)); }
            }
          }
          return value;
        }
        return undefined;
      },
      set(v) { Object.defineProperty(this, name, { value: v, writable: true, configurable: true, enumerable: true }); },
    });
  };
  define('transparent', true);
  define('backgroundColor', TRANSPARENT);

  // 页面会按主题色调用 setTitleBarOverlay，强制保持透明，避免右上角一块白色；
  // 魔术模式（隐藏）时把系统最小化/最大化/关闭按钮也藏起来，并把区域压到 1px，避免「点一下恢复」时误点到关闭。
  const E = M.createRequire(__BZ_EXE__)('electron');
  let owner = E.BrowserWindow.prototype;
  while (owner && !Object.prototype.hasOwnProperty.call(owner, 'setTitleBarOverlay')) owner = Object.getPrototypeOf(owner);
  if (!owner) owner = E.BrowserWindow.prototype;
  const origSet = owner.setTitleBarOverlay;
  globalThis.__bzSym = '#0f1115';   // 页面按主题给的符号色（原始值）
  globalThis.__bzHidden = false;     // 魔术隐形
  globalThis.__bzMinimal = false;    // 极简模式：系统按钮藏起来，改由页面自己画最小化/最大化（没有关闭键）
  globalThis.__bzTextA = 1;          // 「文字透明度」0..1，系统按钮的符号色跟着变
  const toRgb = (s) => {
    s = String(s || '').trim();
    let m = /^#([\da-f]{3,8})$/i.exec(s);
    if (m) { let x = m[1]; if (x.length <= 4) x = [...x].map((c) => c + c).join(''); return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)]; }
    m = /rgba?\(([^)]+)\)/.exec(s);
    if (m) { const p = m[1].split(/[\s,\/]+/).map(parseFloat); return [p[0], p[1], p[2]]; }
    return [15, 17, 21];
  };
  const overlayFor = (base) => {
    const hideSys = globalThis.__bzHidden || globalThis.__bzMinimal;
    const o = Object.assign({}, base || {}, { color: TRANSPARENT });
    if (hideSys) { o.symbolColor = TRANSPARENT; o.height = 1; }
    else {
      const c = toRgb(globalThis.__bzSym);
      o.symbolColor = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + Math.max(0, Math.min(1, globalThis.__bzTextA)) + ')';
      if (!o.height) o.height = 40;
    }
    return o;
  };
  globalThis.__bzOverlayFor = overlayFor;
  if (typeof origSet === 'function') {
    owner.setTitleBarOverlay = function (x) {
      if (globalThis.__bzSelfButtons) return; // 没有原生按钮了，页面按主题发来的同步请求直接忽略
      x = Object.assign({}, x);
      if (x.symbolColor && !globalThis.__bzHidden && !globalThis.__bzMinimal) globalThis.__bzSym = x.symbolColor;
      return origSet.call(this, overlayFor(x));
    };
  }
  globalThis.__bzOrigSet = origSet;
  const chatWins = () => E.BrowserWindow.getAllWindows().filter((w) => { try { return !w.isDestroyed() && w.webContents.getURL().startsWith('dsh-app://app/'); } catch (e) { return false; } });
  globalThis.__bzChatWins = chatWins;
  // ---------- 魔术模式：跟窗口焦点绑定（主进程 BrowserWindow 'blur' / 'focus'） ----------
  // 隐形 = 魔术模式开启 && 聊天主窗口失焦。隐形时把系统标题栏按钮藏起来并压到 1px，避免「点一下恢复」误点到关闭。
  const BW = E.BrowserWindow;
  globalThis.__bzMagic = false;
  globalThis.__bzModal = 0; // >0：有原生对话框/菜单打开，不算失焦
  const state = { focused: true };
  const computeFocused = () => {
    const chats = chatWins();
    if (!chats.length) return true;
    if (globalThis.__bzModal > 0) return true;
    const fw = BW.getFocusedWindow();
    if (!fw) return false;
    if (chats.includes(fw)) return true;
    try { for (const c of chats) { if (fw.getParentWindow() === c || c.getChildWindows().includes(fw)) return true; } } catch (e) {}
    return false;
  };
  // ---------- 隐藏 / 显示：完全在主进程里用 win.setOpacity 做（不经过 启动器 → CDP → 页面） ----------
  // 页面的皮肤 CSS 和设置一直保持生效，只改窗口这一个透明度值；不用 hide()/show()/最小化（它们会触发重绘）。
  // 隐藏时留 0.01 的透明度而不是 0：肉眼看不见，但窗口仍然能接收点击（不会穿透到桌面）。
  const fade = { outMs: 120, inMs: 0, min: 0.01, cur: 1, timer: null };
  const applyOpacity = (v) => {
    fade.cur = v;
    for (const w of chatWins()) { try { w.setOpacity(v); } catch (e) {} }
  };
  const fadeTo = (target, ms) => {
    if (fade.timer) { clearInterval(fade.timer); fade.timer = null; }
    if (Math.abs(target - fade.cur) < 0.005 && !fade.timer) return; // 已经在目标值：不要重复调用 setOpacity（每次调用都会让分层窗口重新合成）
    if (!ms || ms <= 0) { applyOpacity(target); return; }
    const from = fade.cur, t0 = process.hrtime.bigint();
    fade.timer = setInterval(() => {
      const p = Math.min(1, Number(process.hrtime.bigint() - t0) / 1e6 / ms);
      applyOpacity(from + (target - from) * (1 - (1 - p) * (1 - p))); // ease-out
      if (p >= 1) { clearInterval(fade.timer); fade.timer = null; }
    }, 10);
  };
  const updateVisibility = () => {
    const hid = !!globalThis.__bzMagic && !state.focused;
    globalThis.__bzHidden = hid;
    fadeTo(hid ? fade.min : 1, hid ? fade.outMs : fade.inMs);
    return hid;
  };
  const updateOverlay = updateVisibility; // 旧名字保留（调用点不变）
  const pushFocus = () => {
    // 只告诉页面「窗口现在在不在前台」：页面用它来决定要不要挡住唤醒那一下点击（veil），不改任何外观
    for (const w of chatWins()) {
      try { w.webContents.executeJavaScript('window.__bz&&window.__bz.setFocus(' + state.focused + ')', true).catch(() => {}); } catch (e) {}
    }
  };
  const sync = () => {
    const f = computeFocused();
    if (f === state.focused) return;
    state.focused = f;
    const t0 = process.hrtime.bigint();
    const hid = updateVisibility(); // 先改窗口透明度（最快），再通知页面
    pushFocus();
    log('chat window focused =', f, hid ? '-> hide' : '-> show', 'handled in', (Number(process.hrtime.bigint() - t0) / 1e6).toFixed(2) + 'ms');
  };
  E.app.on('browser-window-created', (ev, w) => {
    try { w.webContents.setBackgroundThrottling(false); } catch (e) {} // 隐形时页面不降频、不停止重绘，恢复时不会显示旧帧/白帧
    w.on('blur', () => { sync(); setTimeout(sync, 40); }); // 立刻处理；40ms 后再确认一次（焦点只是转到子窗口时会被纠正回来）
    w.on('focus', () => sync());
    w.on('show', () => setTimeout(sync, 60));
    w.on('closed', () => setTimeout(sync, 60));
  });
  // 原生对话框（文件选择框等）/ 原生菜单弹出期间，窗口会失焦，但不应该隐形
  const modalWrap = (obj, names, sync_) => {
    for (const n of names) {
      const o = obj && obj[n];
      if (typeof o !== 'function') continue;
      try {
        obj[n] = function (...args) {
          globalThis.__bzModal++;
          const done = () => setTimeout(() => { globalThis.__bzModal = Math.max(0, globalThis.__bzModal - 1); sync(); }, 250);
          let r;
          try { r = o.apply(this, args); } catch (e) { done(); throw e; }
          if (sync_) done(); else Promise.resolve(r).then(done, done);
          return r;
        };
      } catch (e) { log('wrap failed', n, String(e)); }
    }
  };
  modalWrap(E.dialog, ['showOpenDialog', 'showSaveDialog', 'showMessageBox', 'showCertificateTrustDialog'], false);
  modalWrap(E.dialog, ['showOpenDialogSync', 'showSaveDialogSync', 'showMessageBoxSync', 'showErrorBox'], true);
  try {
    const mp = E.Menu.prototype.popup;
    E.Menu.prototype.popup = function (opts) {
      globalThis.__bzModal++;
      const o = Object.assign({}, opts || {});
      const cb = o.callback;
      o.callback = () => { setTimeout(() => { globalThis.__bzModal = Math.max(0, globalThis.__bzModal - 1); sync(); }, 250); if (cb) cb(); };
      return mp.call(this, o);
    };
  } catch (e) { log('wrap Menu.popup failed', String(e)); }

  // ---------- 任务栏：AppUserModelID + 重新启动命令（必须在 Harness 进程内设置） ----------
  // 窗口自己没有显式 AUMID；这里把它设成和快捷方式一致的 ID，快捷方式（固定到任务栏的图标）才会和运行中的窗口合并成一个图标；
  // 同时设置「重新启动命令」，从运行中的窗口再点「固定到任务栏」时，固定下来的也是美化启动器而不是原程序。
  const APPDETAILS = __BZ_APPDETAILS__;
  try { E.app.setAppUserModelId(APPDETAILS.appId); } catch (e) { log('setAppUserModelId failed', String(e)); }
  const applyDetails = (w) => {
    try { if (!w.isDestroyed() && String(w.webContents.getURL()).startsWith('dsh-app://app/')) { w.setAppDetails(APPDETAILS); log('setAppDetails applied'); } } catch (e) { log('setAppDetails failed', String(e)); }
  };
  E.app.on('browser-window-created', (ev, w) => {
    w.webContents.on('did-finish-load', () => applyDetails(w));
    w.on('show', () => setTimeout(() => applyDetails(w), 200));
  });
  globalThis.__bzApplyDetails = () => { for (const w of chatWins()) applyDetails(w); };

  // ---------- 极简模式：缩小最小尺寸 + 自绘边缘缩放（透明无边框窗口在 Windows 上没有原生缩放边） ----------
  const MIN_SMALL = [240, 120];
  const origMin = new WeakMap();
  const applyMinimalSize = (on) => {
    for (const w of chatWins()) {
      try {
        if (on) { if (!origMin.has(w)) origMin.set(w, w.getMinimumSize()); w.setMinimumSize(MIN_SMALL[0], MIN_SMALL[1]); }
        else if (origMin.has(w)) { const m = origMin.get(w); origMin.delete(w); w.setMinimumSize(m[0], m[1]); }
      } catch (e) { log('min size error', String(e)); }
    }
  };
  let rs = null;
  globalThis.__bzRsStop = () => { if (rs) { clearInterval(rs.t); rs = null; } };
  // 按下缩放边后，主进程自己按鼠标位置轮询 setBounds（不经过页面/启动器，跟手）；页面 mouseup 时发 rsend 停止
  globalThis.__bzRsStart = (edge) => {
    globalThis.__bzRsStop();
    const w = chatWins()[0]; if (!w || w.isMaximized()) return;
    const b = w.getBounds(), p0 = E.screen.getCursorScreenPoint(), mn = w.getMinimumSize();
    const minW = mn[0] || MIN_SMALL[0], minH = mn[1] || MIN_SMALL[1];
    const t0 = Date.now();
    rs = { t: setInterval(() => {
      if (w.isDestroyed() || Date.now() - t0 > 60000) return globalThis.__bzRsStop();
      const p = E.screen.getCursorScreenPoint(), dx = p.x - p0.x, dy = p.y - p0.y;
      let { x, y, width, height } = b;
      if (edge.includes('e')) width = Math.max(minW, b.width + dx);
      if (edge.includes('w')) { width = Math.max(minW, b.width - dx); x = b.x + b.width - width; }
      if (edge.includes('s')) height = Math.max(minH, b.height + dy);
      if (edge.includes('n')) { height = Math.max(minH, b.height - dy); y = b.y + b.height - height; }
      w.setBounds({ x, y, width, height });
    }, 8) };
  };
  // 极简模式：在非文字区域按住拖动窗口（页面判断「不是文字/交互元素」并移动超过 3px 后才发 start；主进程按鼠标屏幕坐标持续 setBounds，不经页面）
  let dg = null;
  globalThis.__bzDgStop = () => { if (dg) { clearInterval(dg.t); dg = null; } };
  globalThis.__bzDgStart = () => {
    globalThis.__bzDgStop();
    const w = chatWins()[0]; if (!w || w.isMaximized()) return;
    const b = w.getBounds(), p0 = E.screen.getCursorScreenPoint(), t0 = Date.now();
    dg = { t: setInterval(() => {
      if (w.isDestroyed() || Date.now() - t0 > 120000) return globalThis.__bzDgStop();
      const p = E.screen.getCursorScreenPoint();
      w.setBounds({ x: b.x + p.x - p0.x, y: b.y + p.y - p0.y, width: b.width, height: b.height });
    }, 6) };
  };
  // 窗口太小（宽 < 260 或高 < 300）时设置菜单放不下：弹出一个独立的小设置窗口（无边框，出现在主窗口旁边，失焦/Esc 关闭）。
  // 窗口里是同一个注入脚本（启动器会把它注入 about:blank 页面），由页面的 __bz.panelMode() 切成「整窗菜单」。
  let panel = null;
  globalThis.__bzPanelClose = () => { try { if (panel && !panel.isDestroyed()) panel.close(); } catch (e) {} panel = null; };
  globalThis.__bzPanelToggle = (dark) => {
    if (panel && !panel.isDestroyed()) { globalThis.__bzPanelClose(); return 'closed'; }
    const main = chatWins()[0]; if (!main) return 'nomain';
    const b = main.getBounds(), wa = E.screen.getDisplayMatching(b).workArea, W = 300, H = 470;
    let x = b.x + b.width + 8; if (x + W > wa.x + wa.width) x = b.x - W - 8; if (x < wa.x) x = Math.max(wa.x, Math.min(b.x, wa.x + wa.width - W));
    const y = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - H));
    panel = new E.BrowserWindow({ x, y, width: W, height: Math.min(H, wa.height), frame: false, resizable: false, minimizable: false, maximizable: false, skipTaskbar: true, parent: main, show: false, alwaysOnTop: true, backgroundColor: dark ? '#26262b' : '#ffffff', hasShadow: true });
    const pw = panel;
    pw.once('ready-to-show', () => { try { pw.show(); pw.focus(); } catch (e) {} });
    pw.on('blur', () => setTimeout(() => { try { if (!pw.isDestroyed() && !pw.isFocused()) pw.close(); } catch (e) {} }, 120));
    pw.on('closed', () => { if (panel === pw) panel = null; });
    pw.loadURL('about:blank');
    let n = 0; // 等启动器把注入脚本装进这个页面，再切到面板模式
    const iv = setInterval(() => {
      if (pw.isDestroyed() || ++n > 60) return clearInterval(iv);
      pw.webContents.executeJavaScript('(window.__bz&&window.__bz.panelMode)?(window.__bz.panelMode(' + (dark ? 'true' : 'false') + '),1):0', true).then((r) => { if (r === 1) clearInterval(iv); }).catch(() => {});
    }, 100);
    return 'opened';
  };
  let lastMinimal = false;
  globalThis.__bzSetState = (s) => {
    globalThis.__bzMagic = !!s.magic;
    globalThis.__bzMinimal = !!s.minimal;
    if (!!s.minimal !== lastMinimal) { lastMinimal = !!s.minimal; applyMinimalSize(lastMinimal); if (!lastMinimal) globalThis.__bzRsStop(); }
    globalThis.__bzTextA = typeof s.t === 'number' ? s.t : 1;
    if (typeof s.fadeOutMs === 'number') fade.outMs = Math.max(0, Math.min(1000, s.fadeOutMs));
    if (typeof s.fadeInMs === 'number') fade.inMs = Math.max(0, Math.min(1000, s.fadeInMs));
    state.focused = computeFocused();
    updateVisibility(); // 只在可见性真的变了才会动窗口；拖滑块时这里每 60ms 会被调用一次，必须几乎零开销
    return state.focused;
  };
  globalThis.__bzSetMagic = (v) => globalThis.__bzSetState({ magic: v, minimal: globalThis.__bzMinimal, t: globalThis.__bzTextA });
  // 极简模式下页面自己画的最小化/最大化按钮调用这里（极简模式没有关闭键）
  globalThis.__bzWinOp = (op) => {
    for (const w of chatWins()) {
      try {
        if (op === 'min') w.minimize();
        else if (op === 'max') { if (w.isMaximized()) w.unmaximize(); else w.maximize(); }
        else if (op === 'close') w.close(); // 和原来的 X 一样：由程序自己决定是隐藏到托盘还是退出
      } catch (e) { log('winop error', String(e)); }
    }
  };
  globalThis.__bzIsFocused = () => { state.focused = computeFocused(); return state.focused; };
  globalThis.__bzFocus = () => { for (const w of chatWins()) { try { if (w.isMinimized()) w.restore(); w.show(); w.focus(); } catch (e) {} } };
  // ---------- 控制管道：启动器之后都通过它控制主进程，hook 装好后 inspector 就被启动器关掉 ----------
  // 命名管道名是随机的，并且每个连接必须先发令牌（随机，只写在启动器目录的 run.json 里）；不监听任何 TCP 端口。
  try {
    const PIPE = __BZ_PIPE__, TOKEN = __BZ_TOKEN__;
    const net = process.getBuiltinModule('node:net');
    const srv = net.createServer((sock) => {
      sock.setEncoding('utf8');
      let buf = '', authed = false;
      sock.on('error', () => {});
      const reply = (o) => {
        try { let s; try { s = JSON.stringify(o); } catch (e) { o.value = String(o.value); s = JSON.stringify(o); } sock.write(s + '\n'); } catch (e) {}
      };
      const handle = (line) => {
        let m; try { m = JSON.parse(line); } catch (e) { return; }
        if (!authed) { if (m.auth === TOKEN) authed = true; else sock.destroy(); return; }
        Promise.resolve().then(() => (0, eval)(m.expr)).then((v) => reply({ id: m.id, ok: true, value: v === undefined ? null : v }), (e) => reply({ id: m.id, ok: false, error: String(e && e.message || e) }));
      };
      sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); handle(l); } });
    });
    srv.on('error', (e) => log('control pipe error', String(e)));
    srv.listen(PIPE);
    globalThis.__bzPipeServer = srv;
  } catch (e) { log('control pipe failed', String(e)); }
  log('hook installed; node', process.version, 'electron', process.versions.electron, 'setTitleBarOverlay patched:', typeof origSet === 'function');
  return 'installed';
})()
