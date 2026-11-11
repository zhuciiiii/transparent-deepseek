// 读取 config.json（由 detect.ps1 生成）。Harness 被更新/搬家导致路径失效时，自动重新检测。
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const DIR = __dirname;
const CFG = path.join(DIR, 'config.json');

function readCfg() {
  try { return JSON.parse(fs.readFileSync(CFG, 'utf8').replace(/^﻿/, '')); } catch (e) { return null; }
}
function valid(c) { return !!(c && c.exe && c.node && fs.existsSync(c.exe) && fs.existsSync(c.node)); }
function detect(force, noPrompt) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(DIR, 'detect.ps1'), '-Quiet'];
  if (force) args.push('-Force');
  if (noPrompt) args.push('-NoPrompt');
  cp.spawnSync('powershell.exe', args, { windowsHide: true, timeout: 120000 });
  return readCfg();
}
// 返回 { exe, root, node, version }；找不到时返回 null
function load(opts = {}) {
  if (process.env.DSH_EXE && fs.existsSync(process.env.DSH_EXE)) {
    const exe = process.env.DSH_EXE;
    return { exe, root: path.dirname(exe), node: process.execPath, version: '' };
  }
  let c = readCfg();
  if (valid(c)) return c;
  c = detect(true, !!opts.noPrompt);
  return valid(c) ? c : null;
}
module.exports = { load, detect, CFG };
