// DeepSeek Harness 美化启动器：不修改 deep\ 下任何文件（不碰 app.asar）。
// 1) 用 --inspect-brk + --remote-debugging-port 启动 Harness；在主进程 main.js 执行之前，通过 Node 调试连接
//    执行 hook.js，让聊天主窗口以 transparent:true 创建（transparent 只能在窗口创建时设置）。
// 2) 通过 CDP 把 inject.js 注入页面（刷新/新窗口自动重新注入），页面用 Runtime.addBinding 回调本启动器。
// 3) helper.ps1 提供全局快捷键和托盘图标。
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const DIR = __dirname;
// 端口全部在启动时随机选一个空闲的、只绑 127.0.0.1（见 launchAndHook）；不再使用固定端口
let PORT = 0;     // 页面 CDP（remote-debugging-port）
let INSPECT = 0;  // 主进程 Node inspector：只在注入 hook 时短暂打开，完成后由 hook 自己关掉
const RUN_FILE = path.join(DIR, 'run.json'); // 本次运行的端口/管道名/令牌（单实例、重新附着用）
const TOKEN = crypto.randomBytes(16).toString('hex');
let PIPE_NAME = '';
const SETTINGS_FILE = path.join(DIR, 'settings.json');
const LOG_FILE = path.join(DIR, 'hook.log');
const BINDING = '__bzCall';
const FORWARD_ARGS = process.argv.slice(2); // 快捷方式/开机自启里原来带的启动参数（比如 --hidden），转发给 Harness
const DEFAULTS = { opacity: 100, textFade: 100, minimal: false, magic: false, textColor: '', colorIcons: false };
// 只在 settings.json 里配置（菜单里没有）：魔术模式隐藏/显示的时间（毫秒，0 = 瞬间）
const FADE = { fadeOutMs: 120, fadeInMs: 0 };

const LAUNCHER_LOG = path.join(DIR, 'launcher.log');
const log = (...a) => {
  const line = new Date().toLocaleTimeString() + ' +' + Math.round(process.uptime() * 1000) + 'ms ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  try { console.log(line); } catch (e) {}
  try { fs.appendFileSync(LAUNCHER_LOG, line + '\n'); } catch (e) {}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 设置（魔术模式不持久化，免得下次启动就是一个看不见的窗口） ----------
let S = Object.assign({}, DEFAULTS);
try { S = Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); } catch (e) {}
for (const k of ['fadeOutMs', 'fadeInMs']) if (Number.isFinite(+S[k])) FADE[k] = Math.max(0, Math.min(1000, +S[k]));
S = { opacity: S.opacity, textFade: S.textFade, minimal: !!S.minimal, magic: false, textColor: /^#[0-9a-fA-F]{6}$/.test(S.textColor || '') ? S.textColor.toLowerCase() : '', colorIcons: !!S.colorIcons };
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { magic, ...persist } = S;
    try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(Object.assign(persist, FADE), null, 2)); } catch (e) { log('保存设置失败', e.message); }
  }, 300);
}

// ---------- 小型 CDP 客户端 ----------
class Cdp {
  constructor(url) { this.url = url; this.id = 1; this.pending = new Map(); this.onEvent = () => {}; this.onClose = () => {}; }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('ws error ' + this.url)); });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m.result || m.error || {}); this.pending.delete(m.id); }
      else if (m.method) this.onEvent(m);
    };
    this.ws.onclose = () => this.onClose();
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve) => {
      const id = this.id++;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}
async function getJson(port, p) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(1500) });
  return r.json();
}
async function alive(port, p = '/json/version') { try { await getJson(port, p); return true; } catch (e) { return false; } }
function harnessRunning() {
  try { return /DeepSeek Harness\.exe/i.test(cp.execSync('tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /NH', { encoding: 'utf8', windowsHide: true })); } catch (e) { return false; }
}
// 已经用普通方式开着（没带调试端口 / 没被钩过）的 Harness：关掉再用美化版重开
async function killHarness() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { cp.execSync('taskkill /F /T /IM "DeepSeek Harness.exe"', { stdio: 'ignore', windowsHide: true }); } catch (e) {}
    for (let i = 0; i < 20; i++) { if (!harnessRunning()) return true; await sleep(250); }
  }
  return !harnessRunning();
}
function showError(text) {
  log('[错误]', text);
  try {
    const ps = `Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show(${JSON.stringify(text).replace(/"/g, "'")}, 'DeepSeek Harness 美化')`;
    cp.spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { stdio: 'ignore', windowsHide: true, detached: true }).unref();
  } catch (e) {}
}

// Harness 位置：来自 config.json（detect.ps1 自动检测）；失效（更新/搬家）时自动重新检测
const CONFIG = require('./config.js').load();
if (!CONFIG) { showError('找不到 DeepSeek Harness。请运行 install.bat（会让你选择 DeepSeek Harness.exe 的位置）。'); setTimeout(() => process.exit(3), 1500); }
const EXE = CONFIG ? CONFIG.exe : '';

// 任务栏：快捷方式的 AppUserModelID（和原程序快捷方式一致）+ 从运行中的窗口固定到任务栏时使用的「重新启动命令」
const WSCRIPT = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'wscript.exe');
const VBS = path.join(DIR, 'launch.vbs');
const APPDETAILS = {
  appId: process.env.DSH_APPID || 'com.deepseek.dsh',
  relaunchCommand: '"' + WSCRIPT + '" //B "' + VBS + '"',
  relaunchDisplayName: 'DeepSeek Harness',
  appIconPath: EXE,
  appIconIndex: 0,
};

// ---------- 主进程（Node inspector） ----------
// 安全：inspector 只在注入 hook 的那几百毫秒里开着（127.0.0.1 + 随机端口）。hook 在 Harness 主进程里另开一个
// 「随机名字的命名管道 + 随机令牌」的小服务，之后启动器都走管道（mainEval），并把 inspector 关掉。
let main = null; // Cdp（仅注入阶段 / 管道失败时的后备）
let pipe = null; // Pipe
const hookSource = () => fs.readFileSync(path.join(DIR, 'hook.js'), 'utf8')
  .replace('__BZ_LOG__', JSON.stringify(LOG_FILE.replace(/\\/g, '/')))
  .replace(/__BZ_EXE__/g, JSON.stringify(EXE.replace(/\\/g, '/')))
  .replace('__BZ_PIPE__', JSON.stringify(PIPE_NAME))
  .replace('__BZ_TOKEN__', JSON.stringify(TOKEN))
  .replace('__BZ_APPDETAILS__', JSON.stringify(APPDETAILS));

class Pipe {
  constructor(name, token) { this.name = name; this.token = token; this.id = 1; this.pending = new Map(); this.onClose = () => {}; }
  connect() {
    return new Promise((resolve, reject) => {
      const sock = this.sock = net.connect(this.name);
      sock.setEncoding('utf8');
      let buf = '';
      sock.on('connect', () => { sock.write(JSON.stringify({ auth: this.token }) + '\n'); resolve(); });
      sock.on('error', (e) => reject(e));
      sock.on('data', (d) => {
        buf += d; let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          try { const m = JSON.parse(line); const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.ok ? p.res(m.value) : p.rej(new Error(m.error)); } } catch (e) {}
        }
      });
      sock.on('close', () => { for (const p of this.pending.values()) p.rej(new Error('pipe closed')); this.pending.clear(); this.onClose(); });
    });
  }
  eval(expr, timeoutMs = 15000) {
    return new Promise((res, rej) => {
      const id = this.id++;
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error('pipe timeout')); }, timeoutMs);
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      try { this.sock.write(JSON.stringify({ id, expr }) + '\n'); } catch (e) { clearTimeout(t); rej(e); }
    });
  }
  close() { try { this.sock.destroy(); } catch (e) {} }
}

async function mainEval(expression) {
  if (pipe) return pipe.eval(expression);
  if (!main) return undefined;
  const r = await main.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result ? r.result.value : undefined;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function readRun() { try { return JSON.parse(fs.readFileSync(RUN_FILE, 'utf8')); } catch (e) { return null; } }
function writeRun(patch) { try { fs.writeFileSync(RUN_FILE, JSON.stringify(Object.assign(readRun() || {}, patch, { pid: process.pid }), null, 2)); } catch (e) { log('写 run.json 失败', e.message); } }

// maxMs：等主进程 inspector 出现的最长时间；超时返回 false（普通方式已在运行时，新进程会立刻把控制权交给旧进程然后退出）
async function launchAndHook(maxMs = 20000) {
  try { fs.unlinkSync(LOG_FILE); } catch (e) {}
  log('启动 Harness（--inspect-brk 在 main.js 之前注入窗口钩子）...');
  PORT = await freePort(); INSPECT = await freePort();
  PIPE_NAME = '\\\\.\\pipe\\bz-' + crypto.randomBytes(12).toString('hex');
  writeRun({ page: PORT, pipe: PIPE_NAME, token: TOKEN });
  const child = cp.spawn(EXE, [`--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1', `--inspect-brk=127.0.0.1:${INSPECT}`,
    // 隐形（窗口几乎透明）时页面不能停止重绘/降频，否则恢复时会显示旧帧或白帧
    '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', ...FORWARD_ARGS], { detached: true, stdio: 'ignore', cwd: path.dirname(EXE) });
  child.unref();
  let list = null;
  const t0 = Date.now();
  while (!list && Date.now() - t0 < maxMs) {
    try { const l = await getJson(INSPECT, '/json/list'); if (l.length) list = l; } catch (e) {}
    if (!list) await sleep(20);
  }
  if (!list) { if (maxMs < 20000) return false; throw new Error('连不上主进程调试端口（EnableNodeCliInspectArguments fuse 可能被关闭）'); }
  main = new Cdp(list[0].webSocketDebuggerUrl);
  await main.open();
  let onPaused; const paused = new Promise((r) => (onPaused = r));
  main.onEvent = (m) => { if (m.method === 'Debugger.paused') onPaused(); };
  await main.send('Debugger.enable');
  await main.send('Runtime.runIfWaitingForDebugger');
  await Promise.race([paused, sleep(15000)]);
  const rr = await main.send('Runtime.evaluate', { expression: hookSource(), returnByValue: true }); const res = rr.exceptionDetails ? 'ERROR ' + JSON.stringify(rr.exceptionDetails.exception && rr.exceptionDetails.exception.description).slice(0, 400) : (rr.result && rr.result.value);
  log('主进程钩子：', res);
  await main.send('Debugger.resume');
  await main.send('Debugger.disable');
  main.onEvent = () => {};
  main.onClose = () => { if (!quitting) { log('Harness 主进程已退出'); shutdown(); } };
  // 改走命名管道，然后关掉 inspector（失败就保留 inspector 作后备，只是端口会一直开着）
  try {
    const p = new Pipe(PIPE_NAME, TOKEN);
    let ok = false;
    for (let i = 0; i < 100 && !ok; i++) { try { await p.connect(); ok = true; } catch (e) { await sleep(50); } }
    if (!ok) throw new Error('连不上 hook 的管道');
    if ((await p.eval('globalThis.__bzHooked === true')) !== true) throw new Error('管道另一端没有 hook');
    main.onClose = () => {};
    await p.eval("process.getBuiltinModule('node:inspector').close(), 'closed'");
    try { main.ws.close(); } catch (e) {}
    main = null; pipe = p;
    pipe.onClose = () => { if (!quitting) { log('Harness 主进程已退出（管道断开）'); shutdown(); } };
    log('inspector 已关闭，主进程控制改走命名管道；inspector 端口仍监听：', await alive(INSPECT, '/json/list'));
  } catch (e) { log('[警告] 管道不可用，inspector 端口保持打开：', e.message); }
  return true;
}

async function attachExisting() {
  // 已有实例：只有它是被（某个旧的）本启动器钩过的（run.json 里有管道名和令牌，且 __bzHooked）才有透明窗口
  const r = readRun();
  if (!r || !r.pipe || !r.token || !r.page) return false;
  const p = new Pipe(r.pipe, r.token);
  try { await p.connect(); if ((await p.eval('globalThis.__bzHooked === true', 4000)) !== true) throw new Error('not hooked'); }
  catch (e) { p.close(); return false; }
  PORT = r.page; PIPE_NAME = r.pipe;
  if (!(await alive(PORT))) { p.close(); return false; }
  pipe = p;
  pipe.onClose = () => { if (!quitting) { log('Harness 主进程已退出（管道断开）'); shutdown(); } };
  // 旧启动器的令牌已经写在 run.json 里；本启动器要重新生成管道令牌太麻烦，所以沿用旧令牌（只是本进程内的 TOKEN 用于控制端口）
  return true;
}

async function ensureHarness() {
  const run = readRun();
  const pageAlive = !!(run && run.page && await alive(run.page));
  if (pageAlive) {
    if (await attachExisting()) { log('附着到已被钩过的 Harness 实例'); return; }
    PORT = run.page;
    log('检测到没有被钩过的 Harness 实例，关掉后用美化版重开 ...');
    if (!(await killHarness())) { showError('无法关闭正在运行的 DeepSeek Harness，请手动完全退出它（托盘图标右键 -> 退出）后再打开。'); process.exit(2); }
  } else if (harnessRunning()) { // 没有被本启动器钩过（没有 run.json 记录的端口，或页面端口已不通）
    // 注意：不能乐观地直接启动——实测应用并不会因为单实例锁让第二个进程自动退出，结果会同时跑两个实例
    log('检测到以普通方式运行的 Harness（没有调试端口），关掉后用美化版重开 ...');
    if (!(await killHarness())) { showError('无法关闭正在运行的 DeepSeek Harness，请手动完全退出它（托盘图标右键 -> 退出）后再打开。'); process.exit(2); }
  }
  await launchAndHook();
  for (let i = 0; i < 400; i++) { if (await alive(PORT)) return; await sleep(40); }
  throw new Error('等待页面调试端口超时');
}

// ---------- 单实例：再点一次快捷方式只是把已有的美化版窗口带到前台 ----------
// 控制端口：随机端口 + 只绑 127.0.0.1，必须带令牌；端口和令牌写在 run.json 里，第二个启动器从那里读
let controlServer = null;
async function otherLauncherAlive() {
  const r = readRun();
  if (!r || !r.control || !r.ctoken || r.pid === process.pid) return false;
  try { const x = await fetch(`http://127.0.0.1:${r.control}/focus?t=${r.ctoken}`, { signal: AbortSignal.timeout(2500) }); return x.ok; } catch (e) { return false; }
}
function startControlServer() {
  return new Promise((resolve) => {
    controlServer = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/focus' || u.searchParams.get('t') !== TOKEN) { res.writeHead(403); res.end('no'); return; }
      mainEval('globalThis.__bzFocus && globalThis.__bzFocus()').catch(() => {});
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok');
    });
    controlServer.on('error', () => resolve(false));
    controlServer.listen(0, '127.0.0.1', () => { writeRun({ control: controlServer.address().port, ctoken: TOKEN }); resolve(true); });
  });
}

// ---------- 状态 ----------
function clamp(p) {
  for (const k of ['opacity', 'textFade']) if (p[k] != null) p[k] = Math.min(100, Math.max(0, Number.isFinite(+p[k]) ? +p[k] : 100));
  if (p.minimal != null) p.minimal = !!p.minimal;
  if (p.textColor != null) p.textColor = /^#[0-9a-fA-F]{6}$/.test(p.textColor) ? String(p.textColor).toLowerCase() : '';
  if (p.colorIcons != null) p.colorIcons = !!p.colorIcons;
  if (p.magic != null) p.magic = !!p.magic;
  return p;
}
// 主进程需要知道：魔术模式（失焦隐形）、极简模式（系统按钮换成页面自己画的、没有关闭键）、文字透明度（系统按钮符号色的 alpha）
let pushTimer = null;
function pushMain(now) {
  clearTimeout(pushTimer);
  const go = () => mainEval(`globalThis.__bzSetState && globalThis.__bzSetState(${JSON.stringify({ magic: S.magic, minimal: S.minimal, t: S.textFade / 100, fadeOutMs: FADE.fadeOutMs, fadeInMs: FADE.fadeInMs })})`).catch(() => {});
  if (now) go(); else pushTimer = setTimeout(go, 40);
}
// fromSid：发来这次修改的页面不用回显（它已经在本地应用了），只通知其它页面
function update(patch, fromSid) {
  const before = { magic: S.magic, minimal: S.minimal, textFade: S.textFade };
  Object.assign(S, clamp(patch));
  if (S.magic !== before.magic || S.minimal !== before.minimal) pushMain(true);
  else if (S.textFade !== before.textFade) pushMain(false);
  save(); broadcastState(fromSid);
}
function resetAll() {
  S = Object.assign({}, DEFAULTS);
  pushMain(true);
  save(); broadcastState(); broadcast('window.__bz && window.__bz.closeMenu()');
}

// ---------- 页面 CDP ----------
let page = null;
const sessions = new Map(); // sessionId -> targetId
const evalIn = (sid, expression) => page.send('Runtime.evaluate', { expression }, sid);
function broadcast(expression, exceptSid) { for (const sid of sessions.keys()) if (sid !== exceptSid) evalIn(sid, expression); }
function broadcastState(exceptSid) { if (sessions.size === 1 && exceptSid) return; broadcast(`window.__bz && window.__bz.apply(${JSON.stringify(S)})`, exceptSid); }
function buildSource(panel) { return (panel ? 'window.__BZ_PANEL = true;\n' : '') + `window.__BZ_INIT = ${JSON.stringify(S)};\n` + fs.readFileSync(path.join(DIR, 'inject.js'), 'utf8'); }

const panelSessions = new Set();
async function attachPage(sid) {
  await page.send('Runtime.enable', {}, sid);
  await page.send('Runtime.addBinding', { name: BINDING }, sid);
  await page.send('Page.enable', {}, sid);
  const src = buildSource(panelSessions.has(sid));
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: src, runImmediately: true }, sid);
  log('已注入页面', sessions.get(sid));
}
function onPageEvent(m) {
  if (m.method === 'Target.attachedToTarget') {
    const { sessionId, targetInfo } = m.params;
    const u = targetInfo.url || '';
    if (targetInfo.type !== 'page' || u.startsWith('devtools:') || (u && u !== 'about:blank' && !u.startsWith('dsh-app://'))) return; // 只处理 Harness 自己的页面
    sessions.set(sessionId, targetInfo.targetId);
    if (u === 'about:blank' || u === '') panelSessions.add(sessionId);
    attachPage(sessionId).catch((e) => log('注入失败', e.message));
  } else if (m.method === 'Target.detachedFromTarget') sessions.delete(m.params.sessionId);
  else if (m.method === 'Runtime.bindingCalled' && m.params.name === BINDING) {
    let msg; try { msg = JSON.parse(m.params.payload); } catch (e) { return; }
    if (msg.type === 'set') update(msg.patch || {}, m.sessionId);
    else if (msg.type === 'reset') resetAll();
    else if (msg.type === 'win') { if (msg.op === 'min' || msg.op === 'max' || msg.op === 'close') mainEval(`globalThis.__bzWinOp && globalThis.__bzWinOp('${msg.op}')`).catch(() => {}); }
    else if (msg.type === 'rs') { const e = /^[nsew]{1,2}$/.test(msg.edge || '') ? msg.edge : ''; mainEval(e ? `globalThis.__bzRsStart && globalThis.__bzRsStart('${e}')` : `globalThis.__bzRsStop && globalThis.__bzRsStop()`).catch(() => {}); }
    else if (msg.type === 'dg') mainEval(msg.on ? 'globalThis.__bzDgStart && globalThis.__bzDgStart()' : 'globalThis.__bzDgStop && globalThis.__bzDgStop()').catch(() => {});
    else if (msg.type === 'panel') mainEval(msg.close ? 'globalThis.__bzPanelClose && globalThis.__bzPanelClose()' : `globalThis.__bzPanelToggle && globalThis.__bzPanelToggle(${msg.dark ? 'true' : 'false'})`).catch(() => {});
    else if (msg.type === 'hello') {
      pushMain(true);
      mainEval('globalThis.__bzIsFocused ? globalThis.__bzIsFocused() : true').then((f) => {
        evalIn(m.sessionId, `window.__bz && (window.__bz.apply(${JSON.stringify(S)}), window.__bz.setFocus(${f !== false}))`);
      }).catch(() => evalIn(m.sessionId, `window.__bz && window.__bz.apply(${JSON.stringify(S)})`));
    }
  }
}
async function connectPages() {
  const ver = await getJson(PORT, '/json/version');
  page = new Cdp(ver.webSocketDebuggerUrl);
  await page.open();
  page.onEvent = onPageEvent;
  page.onClose = () => { if (!quitting) { log('Harness 已关闭，退出'); shutdown(); } };
  await page.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await page.send('Target.setDiscoverTargets', { discover: true });
  const { targetInfos } = await page.send('Target.getTargets');
  for (const t of targetInfos || []) {
    if (t.type === 'page' && t.url.startsWith('dsh-app://') && ![...sessions.values()].includes(t.targetId)) {
      const r = await page.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      if (r.sessionId && !sessions.has(r.sessionId)) { sessions.set(r.sessionId, t.targetId); attachPage(r.sessionId); }
    }
  }
}

// ---------- helper：全局快捷键 + 托盘 ----------
let helper = null;
function startHelper() {
  helper = cp.spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(DIR, 'helper.ps1'), '-IconExe', EXE], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buf = '';
  helper.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) onHelperLine(line); }
  });
  helper.stderr.on('data', (d) => log('[helper:err]', d.toString().trim()));
  helper.on('exit', (c) => { log('helper 退出', c); if (!quitting) shutdown(); });
}
// 打开设置菜单前先把窗口激活（魔术模式下窗口失焦时是隐形的，激活后会渐显）
function showMenu(toggle) {
  mainEval('globalThis.__bzFocus && globalThis.__bzFocus()').catch(() => {});
  setTimeout(() => broadcast(`window.__bz && window.__bz.${toggle ? 'toggleMenu' : 'openMenu'}()`), 280);
}
function openSettings() { showMenu(true); }
function onHelperLine(line) {
  const [a, b] = line.split(' ');
  if (a === 'hotkey') {
    if (b === 'T') openSettings();
    else if (b === 'M') update({ magic: !S.magic });
    else if (b === '0') resetAll();
  } else if (a === 'tray') {
    if (b === 'menu') showMenu(false);
    else if (b === 'magic') update({ magic: !S.magic });
    else if (b === 'reset') resetAll();
    else if (b === 'winmin' || b === 'winmax') mainEval(`globalThis.__bzWinOp && globalThis.__bzWinOp('${b === 'winmin' ? 'min' : 'max'}')`).catch(() => {});
    else if (b === 'quit') shutdown();
  }
}

// ---------- 退出 ----------
let quitting = false;
function shutdown() {
  if (quitting) return;
  quitting = true;
  try { controlServer && controlServer.close(); } catch (e) {}
  try { const r = readRun(); if (r && r.pid === process.pid) { delete r.control; delete r.ctoken; fs.writeFileSync(RUN_FILE, JSON.stringify(r, null, 2)); } } catch (e) {}
  try { helper && helper.stdin.write('quit\n'); } catch (e) {}
  try { const { magic, ...persist } = S; fs.writeFileSync(SETTINGS_FILE, JSON.stringify(Object.assign(persist, FADE), null, 2)); } catch (e) {}
  setTimeout(() => process.exit(0), 600);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// 快捷方式 / 自启项检查放到启动 20 秒之后的后台里做，而且只在需要时做：
// 受管快捷方式的修改时间变了（比如程序更新重新生成了它）、或距离上次完整检查超过一天。平时只是读几个文件的 mtime。
function scheduleRepair() {
  setTimeout(() => {
    let need = true;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(DIR, 'backup', 'manifest.json'), 'utf8'));
      let st = {}; try { st = JSON.parse(fs.readFileSync(path.join(DIR, 'backup', 'state.json'), 'utf8')); } catch (e) {}
      need = !st.lastFull || Date.now() - st.lastFull > 24 * 3600 * 1000;
      for (const s of m.shortcuts || []) { try { if (st.mtimes && st.mtimes[s.path] !== fs.statSync(s.path).mtimeMs) need = true; } catch (e) { need = true; } }
    } catch (e) { need = true; }
    if (!need) return;
    try { cp.spawn(process.execPath, [path.join(DIR, 'shortcuts.js'), 'repair'], { stdio: 'ignore', windowsHide: true, detached: true }).unref(); } catch (e) { log('repair spawn failed', String(e)); }
  }, 20000);
}

(async () => {
  if (!CONFIG) return;
  if (await otherLauncherAlive()) { log('已有美化启动器在运行：只把窗口带到前台'); process.exit(0); }
  await startControlServer();
  await ensureHarness();
  startHelper();
  pushMain(true);
  await connectPages();
  scheduleRepair();
  log('美化已就绪。皮肤设置：侧边栏左下角按钮 / Ctrl+Alt+T；魔术 Ctrl+Alt+M；恢复 Ctrl+Alt+0。');
})().catch((e) => { showError('美化启动器出错：' + (e && e.message ? e.message : String(e))); shutdown(); });
