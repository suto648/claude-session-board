'use strict';
/*
 * start-board.cmd(と、あれば配布物の起動用.cmd)が cmd.exe に安全に読める形か。
 * tools/check-cmd-encoding.js をそのまま呼び出し、終了コードだけを見る。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const checker = path.join(ROOT, 'tools', 'check-cmd-encoding.js');
const targets = [path.join(ROOT, 'start-board.cmd')];
const distLauncher = path.join(ROOT, 'dist', 'claude-session-board', 'claude-session-boardを起動.cmd');
if (fs.existsSync(distLauncher)) targets.push(distLauncher);

const r = spawnSync(process.execPath, [checker, ...targets], { stdio: 'inherit' });
if (r.status !== 0) {
  console.error('FAILED: .cmd のエンコードに問題がある(上の出力を参照)');
  process.exitCode = 1;
} else {
  console.log('  OK: ' + targets.length + ' 件の .cmd がすべて安全');
}
