'use strict';
/*
 * アイコン3案(A/B/C)それぞれについて、必要な全サイズのPNGと.icoが揃っているか。
 * 加えて既定(A案)への複製(汎用名 app-*.png / app.ico / favicon.ico)も揃っているか。
 * どれが良いかの判定はしない(存在確認のみ)。
 */
const fs = require('fs');
const path = require('path');

const ICONS_DIR = path.join(__dirname, '..', 'public', 'icons');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const VARIANTS = ['app-a', 'app-b', 'app-c'];

let missing = [];
for (const v of VARIANTS) {
  if (!fs.existsSync(path.join(ICONS_DIR, v + '.svg'))) missing.push(v + '.svg');
  for (const s of SIZES) {
    const f = v + '-' + s + '.png';
    if (!fs.existsSync(path.join(ICONS_DIR, f))) missing.push(f);
  }
  if (!fs.existsSync(path.join(ICONS_DIR, v + '.ico'))) missing.push(v + '.ico');
}
for (const s of SIZES) {
  const f = 'app-' + s + '.png';
  if (!fs.existsSync(path.join(ICONS_DIR, f))) missing.push('(汎用名)' + f);
}
if (!fs.existsSync(path.join(ICONS_DIR, 'app.ico'))) missing.push('(汎用名)app.ico');
if (!fs.existsSync(path.join(__dirname, '..', 'public', 'favicon.ico'))) missing.push('public/favicon.ico');

if (missing.length) {
  console.error('  不足: ' + missing.join(', '));
  process.exitCode = 1;
} else {
  console.log(`  OK: 3案(${VARIANTS.join('/')}) x ${SIZES.length}サイズ + ico + 汎用名複製 + favicon が揃っている`);
}
