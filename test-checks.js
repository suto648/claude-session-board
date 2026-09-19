// 検証スクリプト（シェルを介さずJSファイルで実行し、エスケープ由来のノイズを排除）
const s = require('./server.js');

console.log('===== §8-5 エスケープ: 合成トリッキーパス（本物のバックスラッシュ） =====');
// 空白・全角・ハイフンが混ざったパスを試す。
// ★実在の個人フォルダ名を書かない（公開リポジトリなので名前が漏れる）。
const trickyCwd = 'C:\\Users\\name\\OneDrive\\Desktop\\my project - 0706\\my project - コピー';
const args = s.buildTabArgs(trickyCwd, '演出の検討 & 見直し "quote" ;test', '20cb9a0e-3919-460d-a95f-6d516b9599aa');
console.log('cwd要素が1つに保たれているか:', JSON.stringify(args[2]));
console.log('title要素:', JSON.stringify(args[4]));
console.log('-Command要素(自由入力が混ざっていないか):', JSON.stringify(args[9]));

console.log('\n===== §8-5 まとめ: ; が独立要素か =====');
const board = s.loadBoard();
const sessions = s.scanSessions(board).slice(0, 3);
const tabs = sessions.map(x => ({ cwd: x.launchCwd, title: x.displayName, sessionId: x.sessionId }));
const wtArgs = s.buildWtArgs(tabs);
console.log('実データ launchCwd(本物の\\が残るか):', JSON.stringify(sessions.map(x => x.launchCwd)));
console.log('; の位置(独立要素):', wtArgs.map((a, i) => a === ';' ? i : null).filter(x => x !== null));
console.log('DryRun:\n' + s.dryRunString(tabs));

console.log('\n===== §8-3 プレビュー抽出（thinking/tool_use/tool_result が混ざらないか） =====');
const pid = sessions[0].sessionId;
const pv = s.buildPreview(pid);
console.log('sessionId:', pid, '| messageCount:', pv.messageCount, '| exchanges:', pv.exchanges.length);
for (const ex of pv.exchanges.slice(-4)) {
  const t = ex.text.replace(/\s+/g, ' ').slice(0, 70);
  const looksRaw = /"type":|toolu_|thinking|signature|base64/i.test(ex.text.slice(0, 200));
  console.log(`  [${ex.role}]${looksRaw ? ' ⚠RAW?' : ''} ${t}`);
}
