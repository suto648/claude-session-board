'use strict';
/*
 * ポートが別の何かに使われているときの振る舞い:
 *   1. 自分自身(/api/whoamiで確認)なら新しいプロセスは待受せず終了する
 *   2. 別の何かなら、次の空き番号へフォールバックする
 * どちらも server.js の PORT を let にした変更(sameOrigin判定が実ポートに追従する)
 * とセットで壊れていないかを確認する。
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.QA_PORT) || 47974;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'csb-qa-home-'));

function waitForReady(server, timeoutMs) {
  return new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error('起動しません: ' + out)), timeoutMs);
    server.stdout.on('data', d => {
      out += d.toString();
      const m = out.match(/\[ready\] http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    });
    server.stderr.on('data', d => { out += d.toString(); });
  });
}
function waitForExit(server, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('終了しません(二重起動判定が効いていない?)')), timeoutMs);
    server.on('exit', code => { clearTimeout(t); resolve(code); });
  });
}
function spawnServer(port, dataDir) {
  return spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, {
      CSB_PORT: String(port), CSB_HOME: HOME, CSB_DATA_DIR: dataDir,
      CSB_NO_OPEN: '1', CSB_NO_HEARTBEAT: '1',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

(async () => {
  // ---- ケース1: 別の何か(このアプリではないHTTPサーバ)がポートを占有 ----
  const dummy = http.createServer((_, res) => res.end('not this app'));
  await new Promise((resolve, reject) => { dummy.listen(PORT, '127.0.0.1', resolve); dummy.on('error', reject); });
  const dataA = fs.mkdtempSync(path.join(os.tmpdir(), 'csb-qa-dataA-'));
  const serverA = spawnServer(PORT, dataA);
  try {
    const actualPort = await waitForReady(serverA, 10000);
    if (actualPort !== PORT + 1) throw new Error(`フォールバック先が期待と違う: got ${actualPort}, want ${PORT + 1}`);
    console.log(`  OK: 占有中(${PORT})→フォールバック先(${actualPort})が正しい`);
  } finally {
    serverA.kill();
    dummy.close();
    fs.rmSync(dataA, { recursive: true, force: true });
  }

  // ---- ケース2: 自分自身が既に起動中 ----
  const dataB = fs.mkdtempSync(path.join(os.tmpdir(), 'csb-qa-dataB-'));
  const serverB = spawnServer(PORT + 2, dataB);
  try {
    await waitForReady(serverB, 10000);
    const serverB2 = spawnServer(PORT + 2, dataB);
    try {
      const code = await waitForExit(serverB2, 10000);
      if (code !== 0) throw new Error('二重起動時の終了コードが0でない: ' + code);
      console.log('  OK: 自分自身が既に起動中のときは新プロセスが待受せず終了する');
    } finally {
      serverB2.kill();
    }
  } finally {
    serverB.kill();
    fs.rmSync(dataB, { recursive: true, force: true });
  }

  fs.rmSync(HOME, { recursive: true, force: true });
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
