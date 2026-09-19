'use strict';
/*
 * build-dist.ps1 を実際に走らせて、配布物に個人データ・絶対パスが
 * 混ざっていないことを(gate自体の中止ではなく)配布物の実物で確認する。
 * -NoNode: Node.js のダウンロード/コピー(80MB級)を省いて速く回す。
 *          中止ゲート自体はNoNodeでも全部通る(アイコン確認等はNode同梱と無関係)。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist', 'claude-session-board');

const r = spawnSync('powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'build-dist.ps1'), '-NoZip', '-NoNode'],
  { stdio: 'inherit', cwd: ROOT });

if (r.status !== 0) {
  console.error('FAILED: build-dist.ps1 が終了コード ' + r.status + ' で終わった(上の出力を参照)');
  process.exitCode = 1;
  return;
}

// ---- 配布物そのものに個人データが無いか、生成物を直接見て確認する ----
const personalDataNames = ['board.json', 'scan-cache.json', 'status-state.json'];
const found = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) walk(p);
    else if (personalDataNames.includes(name) || /\.corrupt-.*\.bak$/.test(name)) found.push(p);
  }
})(DIST_DIR);
if (found.length) {
  console.error('  個人データが配布物に混ざっている: ' + found.join(', '));
  process.exitCode = 1;
  return;
}
console.log('  OK: 配布物(' + DIST_DIR + ')に個人データ無し');

// ---- 最上位が想定どおりか ----
const top = fs.readdirSync(DIST_DIR);
const allowed = new Set(['app', 'claude-session-boardを起動.cmd', 'はじめにお読みください.txt', 'claude-session-board.lnk']);
const extra = top.filter(n => !allowed.has(n));
if (extra.length) {
  console.error('  最上位に予定外のものがある: ' + extra.join(', '));
  process.exitCode = 1;
  return;
}
console.log('  OK: 最上位のファイル構成 = ' + top.join(', '));
