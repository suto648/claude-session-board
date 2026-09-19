'use strict';
/*
 * app-a / app-b / app-c の3案すべてについて PNG(7サイズ)+ICO を作り、
 * 暫定既定(A案)を汎用名(app.ico / app-<size>.png / favicon.ico)にも複製する。
 *
 * 汎用名を参照しているのは server.js（favicon配信・/api/whoamiとは無関係）と
 * tools/make-icons.js が作る ensureShortcut() 用の .ico。
 * 採用案が決まったら、この複製元を差し替えるだけで済む（3案の生成物自体は消さない）。
 *
 * 使い方: node tools/make-icons-all.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ICONS_DIR = path.join(__dirname, '..', 'public', 'icons');
const VARIANTS = ['app-a', 'app-b', 'app-c'];
const DEFAULT_VARIANT = "app-a"; // ★A案で確定（2026-09-19 ユーザーが3案から選択）
const SIZES = [16, 24, 32, 48, 64, 128, 256];

for (const v of VARIANTS) {
  console.log('=== ' + v + ' ===');
  execFileSync(process.execPath, [path.join(__dirname, 'make-icons.js'), path.join(ICONS_DIR, v + '.svg'), ICONS_DIR], { stdio: 'inherit' });
}

console.log('');
console.log('=== 汎用名へ複製(既定=' + DEFAULT_VARIANT + ') ===');
for (const size of SIZES) {
  fs.copyFileSync(path.join(ICONS_DIR, DEFAULT_VARIANT + '-' + size + '.png'), path.join(ICONS_DIR, 'app-' + size + '.png'));
}
fs.copyFileSync(path.join(ICONS_DIR, DEFAULT_VARIANT + '.ico'), path.join(ICONS_DIR, 'app.ico'));
fs.copyFileSync(path.join(ICONS_DIR, DEFAULT_VARIANT + '.ico'), path.join(__dirname, '..', 'public', 'favicon.ico'));
console.log('  app-<size>.png / app.ico / ../favicon.ico を ' + DEFAULT_VARIANT + ' から複製しました');
