'use strict';
/*
 * テストを全部走らせて、通った／落ちたを正直に集計する。
 * (yarubeki-editor/_qa/run-all.js と同じ設計)
 *
 * ★ `node a.js | tail -1 && node b.js` のような繋ぎ方はしない。
 *   パイプの終了コードがtail等のものにすり替わり、落ちていても
 *   「全部通った」と報告してしまう事故が実際にあったため、
 *   まとめて走らせる口をここに1つだけ用意し、spawnSyncの終了コードだけを見る。
 *
 * 使い方: node _qa/run-all.js
 */
const { spawnSync } = require('child_process');
const path = require('path');

const TESTS = [
  { name: '/api/whoami の形', file: 'test-whoami.js' },
  { name: 'ポートフォールバック・二重起動判定', file: 'test-port-fallback.js' },
  { name: 'アイコン(3案 x 全サイズ + 汎用名複製)', file: 'test-icons.js' },
  { name: '.cmd のエンコード安全性', file: 'test-cmd-encoding.js' },
  { name: '配布物に個人データ・予定外ファイルが無いか', file: 'test-dist-build.js' },
];

const results = [];
for (const t of TESTS) {
  console.log('\n--- ' + t.name + ' ---');
  const r = spawnSync(process.execPath, [path.join(__dirname, t.file)], { stdio: 'inherit' });
  results.push({ name: t.name, status: r.status === 0 ? 'pass' : 'fail', code: r.status });
}

console.log('\n========== まとめ ==========');
for (const r of results) {
  const mark = r.status === 'pass' ? '通った  ' : '★落ちた ';
  console.log(mark + ' ' + r.name + (r.status === 'fail' ? ' (終了コード ' + r.code + ')' : ''));
}
const failed = results.filter(r => r.status === 'fail').length;
console.log('----------------------------');
console.log(failed === 0 ? ('全 ' + results.length + ' 本が通った') : ('★ ' + failed + ' 本が落ちた'));
process.exitCode = failed === 0 ? 0 : 1;
