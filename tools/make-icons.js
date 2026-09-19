'use strict';
/*
 * アイコンの SVG から、Windows が必要とする形を作る。
 * (yarubeki-editor/tools/make-icons.js を移植・複数案対応に一般化)
 *
 * なぜ SVG だけでは足りないか:
 *   - ブラウザのタブは SVG を読めるが、**タスクバーとショートカットは読めない**。
 *     Windows のショートカット(.lnk)は .ico を要求し、
 *     Edge/Chrome をアプリモードで開いたときの窓アイコンは PNG から取られる。
 *   - そのため PNG を複数サイズ作り、それを束ねて .ico にする。
 *
 * 使い方:
 *   node tools/make-icons.js [SVGのパス] [出力先フォルダ]
 *   既定: public/icons/app-a.svg → public/icons/ に app-a-<size>.png / app-a.ico
 *
 *   複数案をまとめて作るときは make-icons-all.js を使う。
 *
 * 依存: playwright-core と Chrome（SVG を描画してもらうため）。
 *       開発時だけ使う道具で、配布物には入らない。
 */

const fs = require('fs');
const path = require('path');

const SVG = process.argv[2] || path.join(__dirname, '..', 'public', 'icons', 'app-a.svg');
const OUT = process.argv[3] || path.join(__dirname, '..', 'public', 'icons');
const PREFIX = path.basename(SVG, '.svg'); // app-a / app-b / app-c
const SIZES = [16, 24, 32, 48, 64, 128, 256];

// playwright-core の置き場所。
// ★特定の人のフォルダを書かない（公開リポジトリなので、書くと持ち主の
//   別プロジェクト名まで漏れる。実際に書いてあったので直した）。
// 見つからなければ PW_CORE 環境変数で教えてもらう。
function findPlaywrightCore() {
  if (process.env.PW_CORE) return process.env.PW_CORE;
  const candidates = [
    path.join(__dirname, '..', 'node_modules', 'playwright-core'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'playwright-core'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  try {
    return path.dirname(require.resolve('playwright-core/package.json'));
  } catch (_) { /* 入っていない */ }
  return null;
}

const PW_CORE = findPlaywrightCore();
const CHROME = process.env.QA_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

if (!PW_CORE) {
  console.error('playwright-core が見つかりません。');
  console.error('  npm i -D playwright-core  を実行するか、');
  console.error('  環境変数 PW_CORE に playwright-core のフォルダを指定してください。');
  process.exit(2);
}

// ---- PNG を束ねて .ico にする -----------------------------------
function buildIco(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const entries = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  pngs.forEach((p, i) => {
    const b = i * 16;
    entries.writeUInt8(p.size >= 256 ? 0 : p.size, b + 0);
    entries.writeUInt8(p.size >= 256 ? 0 : p.size, b + 1);
    entries.writeUInt8(0, b + 2);
    entries.writeUInt8(0, b + 3);
    entries.writeUInt16LE(1, b + 4);
    entries.writeUInt16LE(32, b + 6);
    entries.writeUInt32LE(p.data.length, b + 8);
    entries.writeUInt32LE(offset, b + 12);
    offset += p.data.length;
  });

  return Buffer.concat([header, entries, ...pngs.map(p => p.data)]);
}

async function main() {
  if (!fs.existsSync(SVG)) { console.error('SVG が見つかりません: ' + SVG); process.exit(1); }
  if (!fs.existsSync(CHROME)) { console.error('Chrome が見つかりません: ' + CHROME); process.exit(1); }
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  const { chromium } = require(PW_CORE);
  const svgText = fs.readFileSync(SVG, 'utf-8');
  const ctx = await chromium.launchPersistentContext(
    path.join(require('os').tmpdir(), 'pw-make-icons-' + PREFIX),
    { executablePath: CHROME, headless: true });
  const page = await ctx.newPage();

  const pngs = [];
  for (const size of SIZES) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      '<!DOCTYPE html><html><head><style>' +
      'html,body{margin:0;padding:0;background:transparent}' +
      'svg{display:block;width:' + size + 'px;height:' + size + 'px}' +
      '</style></head><body>' + svgText + '</body></html>',
      { waitUntil: 'load' });
    await page.waitForTimeout(120);
    const data = await page.screenshot({ omitBackground: true, type: 'png' });
    const file = path.join(OUT, PREFIX + '-' + size + '.png');
    fs.writeFileSync(file, data);
    pngs.push({ size, data });
    console.log('  ' + path.basename(file) + '  ' + data.length + ' bytes');
  }
  await ctx.close();

  const ico = buildIco(pngs);
  const icoPath = path.join(OUT, PREFIX + '.ico');
  fs.writeFileSync(icoPath, ico);
  console.log('');
  console.log('  ' + PREFIX + '.ico  ' + ico.length + ' bytes（' + SIZES.join('/') + ' の ' + SIZES.length + '枚入り）');
}

main().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
