// 快捷方式 / 开机自启 管理：install | repair | uninstall | status
//  - 把所有指向原版 "DeepSeek Harness.exe" 的快捷方式（开始菜单、桌面、任务栏固定、启动文件夹…）改成走美化启动器（无窗口：wscript //B launch.vbs），
//    图标、名字、AppUserModelID 都保持原样；改之前备份到 backup\shortcuts\。
//  - 开机自启（HKCU/HKLM Run、启动文件夹、计划任务）同样改成美化版，原来的项目先备份到 backup\manifest.json。
//  - repair：被程序更新改回原版的快捷方式 / 自启项自动修回来；确保「登录时运行的修复任务」存在。
//  - uninstall：全部恢复原样，删除修复任务。
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const DIR = __dirname;
// Harness 位置来自 config.json（detect.ps1 自动检测，失效时自动重新检测；repair/uninstall 时不弹选择窗）
const CONFIG = require('./config.js').load({ noPrompt: process.argv[2] === 'repair' || process.argv[2] === 'uninstall' });
if (!CONFIG) { console.log('[失败] 找不到 DeepSeek Harness（config.json 无效，自动检测也没有找到）。请先运行 install.bat。'); process.exit(3); }
const EXE = CONFIG.exe;
const APPID = process.env.DSH_APPID || 'com.deepseek.dsh';
const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const WSCRIPT = path.join(SYS32, 'wscript.exe');
const VBS = path.join(DIR, 'launch.vbs');
const REPAIR_VBS = path.join(DIR, 'repair.vbs');
const BACKUP = path.join(DIR, 'backup');
const SC_BACKUP = path.join(BACKUP, 'shortcuts');
const TASK_BACKUP = path.join(BACKUP, 'tasks');
const MANIFEST = path.join(BACKUP, 'manifest.json');
const LOG = path.join(DIR, 'shortcuts.log');
const REPAIR_TASK = 'DeepSeekHarnessBeautify-Repair';
const ARGS = '//B "' + VBS + '"';
const REPAIR_ARGS = '//B "' + REPAIR_VBS + '"';
const quiet = process.argv.includes('--quiet') || process.argv[2] === 'repair';

const log = (...a) => {
  const line = new Date().toISOString() + ' ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
  if (!quiet) { try { console.log(a.join(' ')); } catch (e) {} }
};

function ps(args, opts = {}) {
  const r = cp.spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(DIR, 'shell.ps1'), ...args], { encoding: 'utf8', windowsHide: true, ...opts });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'powershell failed').trim().slice(0, 400));
  return (r.stdout || '').trim();
}
const tmpJson = (obj) => { const f = path.join(process.env.TEMP || DIR, 'bz_' + process.pid + '_' + Math.random().toString(36).slice(2) + '.json'); fs.writeFileSync(f, JSON.stringify(obj), 'utf8'); return f; };

function loadManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch (e) { return { version: 1, shortcuts: [], run: [], tasks: [], repair: null }; }
}
function saveManifest(m) { fs.mkdirSync(BACKUP, { recursive: true }); fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2), 'utf8'); }

function userRoots() {
  const e = process.env;
  const roots = [
    path.join(e.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(e.ProgramData || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(e.USERPROFILE || '', 'Desktop'),
    path.join(e.PUBLIC || '', 'Desktop'),
    path.join(e.APPDATA || '', 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned'), // 任务栏固定图标（TaskBar）和开始菜单固定图标（StartMenu）
  ];
  for (const k of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) if (e[k]) roots.push(path.join(e[k], 'Desktop'));
  if (e.BZ_EXTRA_ROOTS) roots.push(...e.BZ_EXTRA_ROOTS.split(';').filter(Boolean));
  return roots.filter((r) => r && fs.existsSync(r));
}

function scanShortcuts() {
  const out = ps(['-Cmd', 'scan', '-Roots', userRoots().join(';'), '-OrigExe', EXE, '-VbsName', path.basename(VBS)]);
  try { const j = JSON.parse(out || '[]'); return Array.isArray(j) ? j : [j]; } catch (e) { log('scan parse failed', out.slice(0, 200)); return []; }
}

// 原来的启动参数（比如 --hidden）接在后面，由启动器转发给 Harness
const withArgs = (orig) => (orig && String(orig).trim() ? ARGS + ' ' + String(orig).trim() : ARGS);
function writeLnk(info, orig) {
  const f = tmpJson({ Path: info.Path, Target: WSCRIPT, Args: withArgs(orig.Args), Icon: orig.Icon && !/wscript/i.test(orig.Icon) ? orig.Icon : EXE + ',0', Wd: DIR, Desc: orig.Desc || 'DeepSeek Harness', Id: orig.Aumid || APPID });
  try { return ps(['-Cmd', 'setlnk', '-Json', f]); } finally { try { fs.unlinkSync(f); } catch (e) {} }
}

function processShortcuts(m, changes) {
  for (const s of scanShortcuts()) {
   try {
    let entry = m.shortcuts.find((x) => x.path.toLowerCase() === s.Path.toLowerCase());
    if (s.Kind === 'orig') {
      if (!entry) {
        fs.mkdirSync(SC_BACKUP, { recursive: true });
        const bak = path.join(SC_BACKUP, require('crypto').createHash('sha1').update(s.Path.toLowerCase()).digest('hex').slice(0, 8) + '_' + path.basename(s.Path));
        fs.copyFileSync(s.Path, bak);
        entry = { path: s.Path, backup: bak, aumid: s.Aumid || APPID, icon: s.Icon, wd: s.Wd, desc: s.Desc, target: s.Target, args: s.Args };
        m.shortcuts.push(entry);
        saveManifest(m);
        log('备份快捷方式', s.Path, '->', bak);
      } else { entry.aumid = s.Aumid || entry.aumid; } // 被更新覆盖成原版了：保留第一次的备份，只更新 AUMID 记录
      writeLnk(s, { Icon: entry.icon, Desc: entry.desc, Aumid: entry.aumid, Args: entry.args });
      log('已改为走美化启动器:', s.Path);
      changes.push(s.Path);
    } else if (s.Kind === 'ours') {
      // 已经是美化版：检查目标/参数/AUMID/图标是否还正确（美化目录移动、更新改图标等）
      const okArgs = s.Args.replace(/"/g, '').toLowerCase().startsWith(ARGS.replace(/"/g, '').toLowerCase());
      const okAumid = !entry || !entry.aumid || s.Aumid === entry.aumid;
      if (!okArgs || !okAumid || s.Target.toLowerCase() !== WSCRIPT.toLowerCase()) {
        writeLnk(s, { Icon: entry ? entry.icon : s.Icon, Desc: entry ? entry.desc : s.Desc, Aumid: entry ? entry.aumid : s.Aumid, Args: entry ? entry.args : '' });
        log('修复美化快捷方式:', s.Path);
        changes.push(s.Path);
      }
    }
   } catch (e) { log('处理快捷方式失败', s.Path, String(e.message)); }
  }
}

// ---------- 开机自启：注册表 Run ----------
function regQuery(hive) {
  const r = cp.spawnSync('reg.exe', ['query', hive + '\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return [];
  const rows = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^\s{4}(.+?)\s{4}(REG_\w+)\s{4}(.*)$/.exec(line);
    if (m) rows.push({ name: m[1], type: m[2], value: m[3] });
  }
  return rows;
}
const regKey = (hive) => hive + '\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = '"' + WSCRIPT + '" ' + ARGS;
function processRunKeys(m, changes) {
  for (const hive of ['HKCU', 'HKLM']) {
    for (const row of regQuery(hive)) {
      const refsExe = row.value.toLowerCase().includes(EXE.toLowerCase());
      const refsOurs = row.value.toLowerCase().includes('launch.vbs');
      if (refsExe && !refsOurs) {
        if (!m.run.find((x) => x.hive === hive && x.name === row.name)) { m.run.push({ hive, name: row.name, type: row.type, value: row.value }); saveManifest(m); log('备份开机自启项', hive, row.name, row.value); }
        const origArgs = row.value.replace(/^\s*"[^"]*"\s*|^\s*\S*DeepSeek Harness\.exe\s*/i, '');
        const r = cp.spawnSync('reg.exe', ['add', regKey(hive), '/v', row.name, '/t', 'REG_SZ', '/d', '"' + WSCRIPT + '" ' + withArgs(origArgs), '/f'], { encoding: 'utf8', windowsHide: true });
        if (r.status === 0) { log('开机自启已改为美化版:', hive, row.name); changes.push(hive + ':' + row.name); } else log('改写开机自启失败（可能需要管理员权限）', hive, row.name, (r.stderr || '').trim());
      }
    }
  }
}

// ---------- 开机自启：计划任务 ----------
function processTasks(m, changes) {
  let list = [];
  try { const j = JSON.parse(ps(['-Cmd', 'tasks', '-OrigExe', EXE]) || '[]'); list = Array.isArray(j) ? j : [j]; } catch (e) { log('读取计划任务失败', String(e.message)); return; }
  for (const t of list) {
    if (!t || !t.Name) continue;
    try {
      if (!m.tasks.find((x) => x.name === t.Name && x.path === t.Path)) {
        fs.mkdirSync(TASK_BACKUP, { recursive: true });
        const xml = path.join(TASK_BACKUP, t.Name.replace(/[^\w.-]+/g, '_') + '.xml');
        ps(['-Cmd', 'taskexport', '-Name', t.Name, '-TaskPath', t.Path, '-Out', xml]);
        m.tasks.push({ name: t.Name, path: t.Path, xml });
        saveManifest(m);
        log('备份计划任务', t.Name, '->', xml);
      }
      const f = tmpJson({ Execute: WSCRIPT, Arguments: withArgs(t.Arguments), Wd: DIR });
      try { ps(['-Cmd', 'taskset', '-Name', t.Name, '-TaskPath', t.Path, '-Json', f]); } finally { try { fs.unlinkSync(f); } catch (e) {} }
      log('计划任务已改为美化版:', t.Name); changes.push('task:' + t.Name);
    } catch (e) { log('改写计划任务失败', t.Name, String(e.message)); }
  }
}

// ---------- 登录时运行的修复任务（防止更新后第一次是从原版快捷方式打开的） ----------
function repairTaskExists() { try { return ps(['-Cmd', 'rtask-exists', '-Name', REPAIR_TASK]) === 'yes'; } catch (e) { return false; } }
const STARTUP_LNK = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'DeepSeek Harness Beautify Repair.lnk');
function ensureRepairTask(m) {
  if (repairTaskExists()) { m.repair = 'task'; return 'task'; }
  try {
    ps(['-Cmd', 'rtask-create', '-Name', REPAIR_TASK, '-Execute', WSCRIPT, '-Arguments', REPAIR_ARGS]);
    m.repair = 'task'; log('已创建登录时运行的修复任务:', REPAIR_TASK); return 'task';
  } catch (e) {
    log('创建计划任务失败，改用启动文件夹项:', String(e.message));
    const f = tmpJson({ Path: STARTUP_LNK, Target: WSCRIPT, Args: REPAIR_ARGS, Icon: EXE + ',0', Wd: DIR, Desc: 'DeepSeek Harness beautify: repair shortcuts' });
    try { ps(['-Cmd', 'setlnk', '-Json', f]); m.repair = 'startup'; log('已创建启动文件夹修复项:', STARTUP_LNK); return 'startup'; }
    catch (e2) { log('创建启动文件夹项也失败', String(e2.message)); return null; } finally { try { fs.unlinkSync(f); } catch (e3) {} }
  }
}

function saveState(m) {
  const st = { lastFull: Date.now(), mtimes: {} };
  for (const x of m.shortcuts) { try { st.mtimes[x.path] = fs.statSync(x.path).mtimeMs; } catch (e) {} }
  try { fs.writeFileSync(path.join(BACKUP, 'state.json'), JSON.stringify(st), 'utf8'); } catch (e) {}
}

function install(isRepair) {
  const m = loadManifest();
  const changes = [];
  processShortcuts(m, changes);
  processRunKeys(m, changes);
  processTasks(m, changes);
  // 默认不创建任何开机项（用户不要开机自启动）：快捷方式的自动修复只发生在每次打开美化版的时候。
  // 只有显式传 --login-repair 才会创建「登录时运行的修复任务」；没传时，把以前创建过的删掉。
  let rt = null;
  if (process.argv.includes('--login-repair')) {
    rt = (m.repair && (m.repair === 'startup' ? fs.existsSync(STARTUP_LNK) : repairTaskExists())) ? m.repair : ensureRepairTask(m);
  } else {
    try { if (repairTaskExists()) { ps(['-Cmd', 'rtask-delete', '-Name', REPAIR_TASK]); log('已删除登录时运行的修复任务（默认不创建开机项）'); } } catch (e) { log('删除修复任务失败', String(e.message)); }
    try { if (fs.existsSync(STARTUP_LNK)) { fs.unlinkSync(STARTUP_LNK); log('已删除启动文件夹修复项'); } } catch (e) {}
    m.repair = null;
  }
  saveManifest(m);
  saveState(m);
  log(isRepair ? 'repair 完成：修改了 ' + changes.length + ' 项；修复任务=' + (rt || "无(不创建开机项)") : 'install 完成：修改了 ' + changes.length + ' 项；修复任务=' + (rt || "无(不创建开机项)"));
  return { changes, repair: rt };
}

function uninstall() {
  const m = loadManifest();
  let n = 0;
  for (const s of m.shortcuts) {
    try {
      if (fs.existsSync(s.backup)) { fs.copyFileSync(s.backup, s.path); n++; log('已恢复快捷方式:', s.path); } else log('备份丢失，无法恢复:', s.path);
    } catch (e) { log('恢复失败', s.path, String(e.message)); }
  }
  for (const r of m.run) {
    const x = cp.spawnSync('reg.exe', ['add', regKey(r.hive), '/v', r.name, '/t', r.type || 'REG_SZ', '/d', r.value, '/f'], { encoding: 'utf8', windowsHide: true });
    if (x.status === 0) { n++; log('已恢复开机自启项:', r.hive, r.name); } else log('恢复开机自启项失败', r.hive, r.name, (x.stderr || '').trim());
  }
  for (const t of m.tasks) {
    try { ps(['-Cmd', 'taskrestore', '-Name', t.name, '-TaskPath', t.path, '-Xml', t.xml]); n++; log('已恢复计划任务:', t.name); } catch (e) { log('恢复计划任务失败', t.name, String(e.message)); }
  }
  try { if (repairTaskExists()) { ps(['-Cmd', 'rtask-delete', '-Name', REPAIR_TASK]); log('已删除修复任务:', REPAIR_TASK); } } catch (e) { log('删除修复任务失败', String(e.message)); }
  try { if (fs.existsSync(STARTUP_LNK)) { fs.unlinkSync(STARTUP_LNK); log('已删除启动文件夹修复项'); } } catch (e) {}
  // 还有没记录在清单里的、指向美化启动器的快捷方式（比如更新后又被我们改过）：恢复成指向原程序
  try {
    for (const s of scanShortcuts()) {
      if (s.Kind === 'ours') {
        const e = m.shortcuts.find((x) => x.path.toLowerCase() === s.Path.toLowerCase());
        if (!e) {
          const f = tmpJson({ Path: s.Path, Target: EXE, Args: '', Icon: EXE + ',0', Wd: path.dirname(EXE), Desc: s.Desc, Id: s.Aumid || APPID });
          try { ps(['-Cmd', 'setlnk', '-Json', f]); n++; log('已恢复（无备份）:', s.Path); } finally { try { fs.unlinkSync(f); } catch (e2) {} }
        }
      }
    }
  } catch (e) { log('扫描残留快捷方式失败', String(e.message)); }
  m.shortcuts = []; m.run = []; m.tasks = []; m.repair = null;
  saveManifest(m);
  log('uninstall 完成：恢复了 ' + n + ' 项');
}

function status() {
  const m = loadManifest();
  console.log('--- 快捷方式 ---');
  for (const s of scanShortcuts()) console.log(`${s.Kind === 'ours' ? '[美化]' : '[原版]'} ${s.Path}  AUMID=${s.Aumid}`);
  console.log('--- 开机自启(Run) ---');
  for (const hive of ['HKCU', 'HKLM']) for (const r of regQuery(hive)) if (/deepseek|harness|launch\.vbs/i.test(r.value)) console.log(`${hive} ${r.name} = ${r.value}`);
  console.log('--- 修复任务 ---');
  console.log('登录时运行的修复任务存在:', repairTaskExists(), ' 启动文件夹修复项存在:', fs.existsSync(STARTUP_LNK), '（默认都不应存在：不创建开机项）');
  console.log('备份清单:', m.shortcuts.length, '个快捷方式,', m.run.length, '个自启项,', m.tasks.length, '个计划任务');
}

const LOCK = path.join(BACKUP, '.lock');
function acquireLock() {
  fs.mkdirSync(BACKUP, { recursive: true });
  for (let i = 0; i < 60; i++) {
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); return true; }
    catch (e) {
      try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 60000) fs.unlinkSync(LOCK); } catch (e2) {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  return false;
}
function releaseLock() { try { fs.unlinkSync(LOCK); } catch (e) {} }

const cmd = process.argv[2] || 'status';
const needLock = cmd === 'install' || cmd === 'repair' || cmd === 'uninstall';
if (needLock && !acquireLock()) { log('另一个 shortcuts 任务正在运行，放弃'); process.exit(0); }
try {
  if (cmd === 'install') install(false);
  else if (cmd === 'repair') install(true);
  else if (cmd === 'uninstall') uninstall();
  else if (cmd === 'status') status();
  else console.log('usage: node shortcuts.js install|repair|uninstall|status');
} catch (e) {
  log('失败:', String(e && e.message || e));
  process.exitCode = 1;
} finally {
  if (needLock) releaseLock();
}
