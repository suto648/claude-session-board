'use strict';
/*
 * /api/whoami が契約どおりの形を返すか。
 * 二重起動判定・配布物の自己確認の土台になっている口なので、形を変えていないか毎回確認する。
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.QA_PORT) || 47970;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'csb-qa-home-'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'csb-qa-data-'));

function startServer() {
  return new Promise((resolve, reject) => {
    const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: Object.assign({}, process.env, {
        CSB_PORT: String(PORT), CSB_HOME: HOME, CSB_DATA_DIR: DATA,
        CSB_NO_OPEN: '1', CSB_NO_HEARTBEAT: '1',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const t = setTimeout(() => reject(new Error('サーバが起動しません: ' + out)), 10000);
    server.stdout.on('data', d => { out += d.toString(); if (out.includes('[ready]')) { clearTimeout(t); resolve(server); } });
    server.stderr.on('data', d => { out += d.toString(); });
    server.on('error', reject);
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

(async () => {
  const server = await startServer();
  try {
    const r = await get(`http://127.0.0.1:${PORT}/api/whoami`);
    if (r.status !== 200) throw new Error('status ' + r.status);
    const j = JSON.parse(r.body);
    if (j.app !== 'claude-session-board') throw new Error('app フィールドが違う: ' + JSON.stringify(j));
    if (j.api !== 1) throw new Error('api フィールドが違う: ' + JSON.stringify(j));
    console.log('  OK: /api/whoami -> ' + JSON.stringify(j));
  } finally {
    server.kill();
    fs.rmSync(HOME, { recursive: true, force: true });
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
