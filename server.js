// =============================================================
//  server.js — Claude Session Board（セッション盤面）
// -------------------------------------------------------------
//  ~/.claude/projects/ の会話(session)を走査して、ピン・プレビュー付き
//  グリッドで見て、ワンクリックで `claude --resume <id>` に入り直す。
//  Node標準モジュールのみ（外部依存なし）。127.0.0.1 限定。
//
//  仕様: REQUIREMENTS.md の §8「v0.2 確定仕様」が正。
// =============================================================
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// ★ 検証用の環境変数（既定値は今までどおり）。本番の起動は何も指定しないので無変更。
//   CSB_PORT: 待受ポート / CSB_HOME: os.homedir() の代わりに使う偽ホーム
//   （~/.claude.json 等・claude-anchor もこの下を見に行く）/
//   CSB_DATA_DIR: board.json・scan-cache.json・status-state.json の置き場所
//   （既定は APP_DIR。本番の board.json 等を検証で書き換えないためのもの）。
// ★ let: ポートフォールバック(listenWithFallback)で実際の待受番号に差し替えるため。
//   sameOrigin()判定やURLパース(下のHTTPハンドラ)はこの変数を都度参照するので、
//   差し替え後は自動的に実際のポートに揃う。
let PORT = Number(process.env.CSB_PORT) || 4788;
const HOST = '127.0.0.1';
const APP_DIR = __dirname;
const HOME = process.env.CSB_HOME ? path.resolve(process.env.CSB_HOME) : os.homedir();
const PROJECTS_ROOT = path.join(HOME, '.claude', 'projects');
const DATA_DIR = process.env.CSB_DATA_DIR ? path.resolve(process.env.CSB_DATA_DIR) : APP_DIR;
const BOARD_FILE = path.join(DATA_DIR, 'board.json');
const PUBLIC_DIR = path.join(APP_DIR, 'public');

// ★ アクティブ判定の真値は home root の ~/.claude.json（`claude` が実際に読む/書く設定）。
//   紛らわしいことに ~/.claude/.claude.json という別ファイルも実在するが【別物】。
//   （中身の oauthAccount も更新時刻も食い違う。こちらは絶対に使わない。）
const ACTIVE_CONFIG_FILE = path.join(HOME, '.claude.json');

// ---- 既定設定（board.json が無ければこれで初期化）----
const DEFAULT_BOARD = {
  pins: {},                                  // sessionId -> { pinned, name, group, order }
  settings: {
    // 一覧から外すプロジェクトフォルダ名。
    // ★既定は空。ここに自分の環境のフォルダ名を書くと、配布物や公開リポジトリに
    //   持ち主の名前が混ざる（実際に混ざっていたので空にした）。
    //   画面の設定から各自で足せる。
    excludeProjects: [],
    minSizeKB: 4,                            // これ未満は挨拶だけとみなし除外
    maxBulkOpen: 10,                         // まとめ開きのハード上限
    bulkConfirmThreshold: 5,                 // これ以上は確認ダイアログ
    // 使用量を見るアカウント。ここを編集すれば増減できる（コード変更不要）。
    // configFile = そのアカウントの設定（oauthAccount と使用量キャッシュを読む）
    // credFile   = そのアカウントの資格情報（トークンはサーバ内だけで使う）
    // label      = 任意の用途名（"仕事用" など）。表示は実emailが主で label は副次。
    //              スロットとアカウントの対応は再ログインで入れ替わるので、
    //              label を「アカウントの名前」として当てにしないこと。
    accounts: [
      { key: 'a', configFile: '~/.claude.json',           credFile: '~/.claude/.credentials.json',   accent: 'blue',   label: '' },
      { key: 'b', configFile: '~/.claude-b/.claude.json', credFile: '~/.claude-b/.credentials.json', accent: 'purple', label: '' },
    ],
    // 朝8時アンカー（平日8:00に各アカウントを1回叩いて5時間枠の起点を揃える）の
    // 結果をここに出す。null にすれば非表示。読むだけで、実行はタスクスケジューラ。
    anchorDir: '~/claude-anchor',
  },
};

// =============================================================
//  board.json（ピン・表示名・設定）— 書くのはこのファイルだけ
// =============================================================
// board.json の読み込み結果（正常/新規作成/壊れていて復旧）。
// ★ obj には混ぜない(saveBoardでファイルへ書き戻ると不要なフィールドが永続化されてしまう)。
// -------------------------------------------------------------
//  ★ ページ初回表示は /api/sessions → /api/status の順で2回 loadBoard() が走る
//    (load()がsessionsを先に叩き、その中でloadStatus()がstatusを叩く)。
//    「新規作成/復旧」は最初の呼び出しで直ってしまうので、直後の呼び出しでは
//    もう lastBoardHealth==='ok' に戻ってしまい、画面(statusを見るcockpit)が
//    気づけない。それを防ぐため、状態そのものとは別に status-state.json へ
//    「通知」を残し、一定時間(BOARD_HEALTH_NOTICE_MS)はどのハンドラからでも
//    拾えるようにする(見落とし防止。スワップ検知の24h窓と同じ考え方)。
// =============================================================
let lastBoardHealth = { status: 'ok' };
const BOARD_HEALTH_NOTICE_MS = 10 * 60 * 1000;
function noteBoardHealth(entry) {
  lastBoardHealth = entry;
  if (entry.status === 'ok') return;
  try {
    const st = loadState();
    st.boardHealthNotice = Object.assign({ atMs: Date.now() }, entry);
    saveState();
  } catch (_) {}
}
// レスポンスに載せる用（直近の生イベントより優先して「まだ新しい通知が残っているか」を見る）
function boardHealthForResponse() {
  try {
    const st = loadState();
    const n = st.boardHealthNotice;
    if (n && n.atMs && (Date.now() - n.atMs) < BOARD_HEALTH_NOTICE_MS) {
      return { status: n.status, detail: n.detail || null, reason: n.reason || null };
    }
  } catch (_) {}
  return { status: 'ok' };
}
function loadBoard() {
  try {
    if (!fs.existsSync(BOARD_FILE)) {
      saveBoard(DEFAULT_BOARD);
      noteBoardHealth({ status: 'created', detail: BOARD_FILE });
      return clone(DEFAULT_BOARD);
    }
    const raw = fs.readFileSync(BOARD_FILE, 'utf8');
    const obj = JSON.parse(raw);
    // 欠けているキーは既定で補完
    obj.pins = obj.pins || {};
    // 設定はユーザーが手で編集するものなので、既定に増えたキーは
    // ファイルへ書き出して「見える・編集できる」状態にする（不足時だけ）。
    const before = obj.settings || {};
    const missing = Object.keys(DEFAULT_BOARD.settings).filter(k => !(k in before));
    obj.settings = Object.assign(clone(DEFAULT_BOARD.settings), before);
    if (missing.length) { try { saveBoard(obj); } catch (_) {} }
    lastBoardHealth = { status: 'ok' }; // ★ noteBoardHealthは使わない(正常時に通知を書く必要は無い)
    return obj;
  } catch (e) {
    // 壊れていたら退避してから初期化（消さない）
    let bak = null;
    try {
      bak = BOARD_FILE + '.corrupt-' + Date.now() + '.bak';
      if (fs.existsSync(BOARD_FILE)) fs.copyFileSync(BOARD_FILE, bak);
      console.error('board.json が壊れていたので退避しました:', bak);
    } catch (_) {}
    saveBoard(DEFAULT_BOARD);
    noteBoardHealth({ status: 'recovered', detail: bak, reason: errCode(e) });
    return clone(DEFAULT_BOARD);
  }
}
function saveBoard(board) {
  fs.writeFileSync(BOARD_FILE, JSON.stringify(board, null, 2), 'utf8');
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }

// =============================================================
//  JSONL 読み取り（Claudeのデータは読むだけ・書き換え厳禁）
// -------------------------------------------------------------
//  巨大ファイル対策(§8-4): 行ベースで遡らず、末尾/先頭のバイト窓で読む。
// =============================================================
function readByteRange(fd, start, len) {
  const buf = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const n = fs.readSync(fd, buf, off, len - off, start + off);
    if (n <= 0) break;
    off += n;
  }
  return buf.slice(0, off);
}

// 先頭 window バイトを読んでテキストで返す
function readHead(filePath, size, window) {
  const len = Math.min(window, size);
  const fd = fs.openSync(filePath, 'r');
  try { return readByteRange(fd, 0, len).toString('utf8'); }
  finally { fs.closeSync(fd); }
}

// 末尾 window バイトを読む。先頭が行の途中なら1行捨てる。
function readTail(filePath, size, window) {
  const start = Math.max(0, size - window);
  const len = size - start;
  const fd = fs.openSync(filePath, 'r');
  let text;
  try { text = readByteRange(fd, start, len).toString('utf8'); }
  finally { fs.closeSync(fd); }
  if (start > 0) {
    const nl = text.indexOf('\n');
    text = nl >= 0 ? text.slice(nl + 1) : text;
  }
  return text;
}

function parseJsonl(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    try { out.push(JSON.parse(s)); } catch (_) {}
  }
  return out;
}

// user/assistant メッセージから text ブロックだけ取り出す(§8-3)
function extractText(o) {
  const c = o && o.message && o.message.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) {
    return c.filter(b => b && b.type === 'text' && typeof b.text === 'string')
            .map(b => b.text).join('\n').trim();
  }
  return '';
}

// タイトルにしてよい発言か（スラッシュ/システム注入/短すぎを除外）
function isMeaningfulUserText(t) {
  if (!t || t.length < 4) return false;
  if (t[0] === '/') return false;
  if (t[0] === '<') return false;                        // 注入タグ全般(system-reminder/task-notification/command-name等)
  if (/^\[image:\s*source:/i.test(t)) return false;      // 添付画像の生参照
  if (/^base directory for this skill:/i.test(t)) return false; // スキル注入の前置き
  if (/^caveat:/i.test(t)) return false;                 // スキル注入の注意書き
  if (/^(続けて|続き(をどうぞ)?|test|ok|はい|うん)$/i.test(t)) return false;
  if (/^continue from where (you|we) left off/i.test(t)) return false; // 自動継続の定型文
  return true;
}

// =============================================================
//  1セッションのメタ抽出（全文1パス。指標もここで数える）
// -------------------------------------------------------------
//  往復数/ツール数/出力トークン/触ったファイル/目次(あなたの指示)を
//  1回の走査で集計。コストは scan-cache.json で mtime+size 毎にキャッシュ
//  するので、2回目以降は再解析しない。
// =============================================================
function deepExtract(filePath, sessionId) {
  const st = fs.statSync(filePath);
  const size = st.size;
  let launchCwd = null, latestCwd = null, firstTs = null, lastTs = null;
  let gitBranch = null, aiTitle = null, model = null, effort = null, hasMsg = false;
  const asks = [];                         // あなたの指示（目次）
  const userTurnTimes = [];                // あなたの発言の時刻（レート自動更新のトリガ判定用）
  let userTurns = 0, assistantCount = 0, toolCount = 0;
  const toolBreakdown = {};
  const files = new Set();
  let outputTokens = 0;
  const seenReq = new Set();               // requestId で使用量の二重計上を防ぐ

  const text = fs.readFileSync(filePath, 'utf8');
  const len = text.length;
  let start = 0;
  while (start < len) {
    let nl = text.indexOf('\n', start);
    if (nl === -1) nl = len;
    const line = text.slice(start, nl); start = nl + 1;
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let o; try { o = JSON.parse(s); } catch (_) { continue; }

    if (o.cwd) { if (!launchCwd) launchCwd = o.cwd; latestCwd = o.cwd; }  // 最初=起動時 / 最後=最新
    if (o.timestamp) { if (!firstTs) firstTs = o.timestamp; lastTs = o.timestamp; }
    if (o.gitBranch && !gitBranch) gitBranch = o.gitBranch;
    if (o.type === 'ai-title' && o.aiTitle) aiTitle = o.aiTitle;         // 最後=最新
    if (o.effort) effort = o.effort;

    if (o.type === 'user') {
      const t = extractText(o).replace(/\s+/g, ' ').trim();
      if (isMeaningfulUserText(t)) { userTurns++; hasMsg = true; if (asks.length < 6) asks.push(t.slice(0, 90)); if (o.timestamp) userTurnTimes.push(o.timestamp); }
    } else if (o.type === 'assistant') {
      hasMsg = true; assistantCount++;
      const m = o.message || {};
      if (m.model && /claude|opus|sonnet|haiku|fable/i.test(m.model)) model = m.model; // <synthetic>等を除外
      const usg = m.usage;
      if (usg) {
        const rid = o.requestId || m.id;
        if (!rid || !seenReq.has(rid)) { if (rid) seenReq.add(rid); outputTokens += usg.output_tokens || 0; }
      }
      for (const b of (m.content || [])) {
        if (b && b.type === 'tool_use') {
          toolCount++; const nm = b.name || '?'; toolBreakdown[nm] = (toolBreakdown[nm] || 0) + 1;
          const inp = b.input || {};
          for (const k of ['file_path', 'path', 'notebook_path']) if (inp[k]) files.add(path.basename(String(inp[k])));
        }
      }
    }
  }

  launchCwd = launchCwd || latestCwd;
  latestCwd = latestCwd || launchCwd;
  const firstUserText = asks.length ? asks[0] : null;
  const displayName = aiTitle || firstUserText || ('session ' + sessionId.slice(0, 8));

  return {
    sessionId, displayName, aiTitle: aiTitle || null,
    projectName: latestCwd ? path.basename(latestCwd) : '',
    launchCwd,                 // ← 復元(-d)・存在チェックはこちら
    latestCwd,                 // ← 表示のプロジェクト名はこちら
    gitBranch: gitBranch && gitBranch !== 'HEAD' ? gitBranch : null,
    firstTs, lastTs, sizeKB: Math.round(size / 1024),
    snippet: firstUserText ? firstUserText.slice(0, 160) : '',
    hasMsg, cwdExists: launchCwd ? safeExists(launchCwd) : false,
    // --- 指標（新）---
    userTurns, assistantCount, toolCount, toolBreakdown, outputTokens,
    model: model || null, effort: effort || null,
    files: [...files].slice(0, 8), asks: asks.slice(0, 4),
    userTurnTimes,   // サーバ内部用（/api/sessions では送信前に除去）
  };
}
function safeExists(p) { try { return fs.existsSync(p); } catch (_) { return false; } }

// ---- 走査結果のディスクキャッシュ（mtime+size で無効化）----
const CACHE_FILE = path.join(DATA_DIR, 'scan-cache.json');
let diskCache = null;
function loadCache() {
  if (diskCache) return diskCache;
  try { diskCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (_) { diskCache = {}; }
  return diskCache;
}
function saveCache() { try { fs.writeFileSync(CACHE_FILE, JSON.stringify(diskCache)); } catch (_) {} }

// =============================================================
//  全セッション走査（§8-2 非再帰・isFile()・subagents除外・キャッシュ）
// =============================================================
function scanSessions(board) {
  const settings = board.settings;
  const cache = loadCache();
  const results = [];
  let dirty = false;
  let projectDirs = [];
  try { projectDirs = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true }); }
  catch (_) { return results; }

  for (const pd of projectDirs) {
    if (!pd.isDirectory()) continue;
    if (settings.excludeProjects.includes(pd.name)) continue;
    const dir = path.join(PROJECTS_ROOT, pd.name);
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }

    for (const e of entries) {
      // 直下のファイルのみ。<uuid>/subagents/ 等のディレクトリには降りない(§8-2)
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const filePath = path.join(dir, e.name);
      const sessionId = e.name.replace(/\.jsonl$/, '');
      let st;
      try { st = fs.statSync(filePath); } catch (_) { continue; }
      if (st.size < settings.minSizeKB * 1024) continue; // 小さすぎ=挨拶だけ

      const key = `${st.mtimeMs}:${st.size}`;
      let meta;
      const c = cache[sessionId];
      if (c && c.key === key) { meta = c.meta; }             // 変わってなければ再解析しない
      else {
        try { meta = deepExtract(filePath, sessionId); } catch (err) { continue; }
        cache[sessionId] = { key, meta }; dirty = true;
      }
      if (!meta.hasMsg) continue; // user/assistant が皆無=実会話なし(§8-2)
      results.push(Object.assign({ mtimeMs: st.mtimeMs }, meta));
    }
  }
  if (dirty) saveCache();
  return results;
}

// 走査結果に board.json のピン・表示名を合成
function buildList(board) {
  const sessions = scanSessions(board);
  const knownIds = new Set(sessions.map(s => s.sessionId));
  const list = sessions.map(s => {
    const p = board.pins[s.sessionId] || {};
    return Object.assign({}, s, {
      pinned: !!p.pinned,
      customName: p.name || null,
      title: p.name || s.displayName,   // 表示名を優先
      group: p.group || null,
      missing: false,
    });
  });
  // 消えたセッションでピンだけ残っているもの → グレーアウト表示用に追加(§8-6)
  for (const [sid, p] of Object.entries(board.pins)) {
    if (p.pinned && !knownIds.has(sid)) {
      list.push({
        sessionId: sid, pinned: true, customName: p.name || null,
        title: p.name || ('session ' + sid.slice(0, 8)),
        projectName: '', launchCwd: null, latestCwd: null, gitBranch: null,
        firstTs: null, lastTs: null, sizeKB: 0, snippet: '', mtimeMs: 0,
        cwdExists: false, missing: true, group: p.group || null,
        userTurns: 0, assistantCount: 0, toolCount: 0, toolBreakdown: {},
        outputTokens: 0, model: null, effort: null, files: [], asks: [],
      });
    }
  }
  return list;
}

// =============================================================
//  プレビュー（§8-3 leafUuid から parentUuid を遡って会話末尾を復元）
// =============================================================
function buildPreview(sessionId) {
  const filePath = findSessionFile(sessionId);
  if (!filePath) return { error: 'not found' };
  const st = fs.statSync(filePath);
  const size = st.size;

  // 少し大きめの末尾窓（足りなければ広げる）で会話末尾を拾う
  let win = 512 * 1024, objs = [], leafUuid = null;
  while (true) {
    objs = parseJsonl(readTail(filePath, size, win));
    leafUuid = null;
    for (const o of objs) if (o.type === 'last-prompt' && o.leafUuid) leafUuid = o.leafUuid;
    const covered = size - win <= 0;
    const byU = new Map(objs.map(o => [o.uuid, o]));
    if ((leafUuid && byU.has(leafUuid)) || covered || win >= 4 * 1024 * 1024) break;
    win *= 2;
  }

  const byUuid = new Map();
  for (const o of objs) if (o.uuid) byUuid.set(o.uuid, o);

  let exchanges = [];
  if (leafUuid && byUuid.has(leafUuid)) {
    // leaf から親へ遡る（物理末尾に依存しない）
    let cur = byUuid.get(leafUuid);
    const seen = new Set();
    const K = 12;
    while (cur && !seen.has(cur.uuid) && exchanges.length < K) {
      seen.add(cur.uuid);
      if (cur.type === 'user' || cur.type === 'assistant') {
        const text = extractText(cur);
        if (text) exchanges.push({ role: cur.type, text });
      }
      cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : null;
    }
    exchanges.reverse();
  }
  if (exchanges.length === 0) {
    // フォールバック: 窓内の user/assistant テキストを順に、末尾から数件
    const seq = [];
    for (const o of objs) {
      if (o.type === 'user' || o.type === 'assistant') {
        const text = extractText(o);
        if (text) seq.push({ role: o.type, text });
      }
    }
    exchanges = seq.slice(-12);
  }

  // メッセージ数: 8MB未満なら全読みで精密、それ以上は概算(null)
  let messageCount = null;
  if (size < 8 * 1024 * 1024) {
    try {
      let n = 0;
      const all = parseJsonl(fs.readFileSync(filePath, 'utf8'));
      for (const o of all) if ((o.type === 'user' || o.type === 'assistant') && extractText(o)) n++;
      messageCount = n;
    } catch (_) {}
  }

  return { sessionId, exchanges, messageCount };
}

function findSessionFile(sessionId) {
  if (!/^[0-9a-fA-F-]{8,}$/.test(sessionId)) return null; // UUID系のみ
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true }); } catch (_) { return null; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const fp = path.join(PROJECTS_ROOT, d.name, sessionId + '.jsonl');
    if (safeExists(fp)) return fp;
  }
  return null;
}

// =============================================================
//  復元（§8-5 wt.exe を配列引数で起動・自由入力は -Command に混ぜない）
// =============================================================
function buildTabArgs(cwd, title, sessionId) {
  // powershell に渡すのは固定形の `claude --resume <uuid>` のみ
  return [
    'new-tab', '-d', cwd, '--title', title,
    'powershell', '-NoExit', '-NoProfile', '-Command', 'claude --resume ' + sessionId,
  ];
}

function buildWtArgs(tabs) {
  // tabs: [{cwd,title,sessionId}] → `-w 0 new-tab ... ; new-tab ...`
  const args = ['-w', '0'];
  tabs.forEach((t, i) => {
    if (i > 0) args.push(';');                 // 区切りは独立要素(§8-5)
    args.push(...buildTabArgs(t.cwd, t.title, t.sessionId));
  });
  return args;
}

let wtResolvable = null; // 起動時に一度だけ判定してキャッシュ
function launchTabs(tabs) {
  const args = buildWtArgs(tabs);
  try {
    const p = spawn('wt.exe', args, { stdio: 'ignore', detached: true, shell: false });
    p.on('error', () => fallbackLaunch(tabs)); // ENOENT 等
    p.unref();
    wtResolvable = true;
    return { ok: true, via: 'wt', tabs: tabs.length };
  } catch (e) {
    return fallbackLaunch(tabs);
  }
}

// wt が解決できない場合(§8-5 B3): 素の powershell ウィンドウを1個ずつ
function fallbackLaunch(tabs) {
  wtResolvable = false;
  for (const t of tabs) {
    const cmd = `Set-Location -LiteralPath '${String(t.cwd).replace(/'/g, "''")}'; claude --resume ${t.sessionId}`;
    try {
      const p = spawn('powershell.exe', ['-NoExit', '-NoProfile', '-Command', cmd],
        { stdio: 'ignore', detached: true, shell: false });
      p.unref();
    } catch (_) {}
  }
  return { ok: true, via: 'powershell-fallback', tabs: tabs.length };
}

// DryRun 表示用に、実際に渡す引数を人間可読な1行にする
function dryRunString(tabs) {
  const args = buildWtArgs(tabs);
  return 'wt.exe ' + args.map(a => /[\s;"']/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a).join(' ');
}

// ---- 新規セッション（resume せず素の claude を新しいタブで起動）----
function launchNew(cwd) {
  const title = 'new: ' + (path.basename(cwd) || cwd);
  const tabArgs = ['new-tab', '-d', cwd, '--title', title, 'powershell', '-NoExit', '-NoProfile', '-Command', 'claude'];
  try {
    const pr = spawn('wt.exe', ['-w', '0', ...tabArgs], { stdio: 'ignore', detached: true, shell: false });
    pr.on('error', () => newFallback(cwd));
    pr.unref(); wtResolvable = true;
    return { ok: true, via: 'wt' };
  } catch (e) { return newFallback(cwd); }
}
function newFallback(cwd) {
  wtResolvable = false;
  try {
    spawn('powershell.exe', ['-NoExit', '-NoProfile', '-Command',
      `Set-Location -LiteralPath '${String(cwd).replace(/'/g, "''")}'; claude`],
      { stdio: 'ignore', detached: true, shell: false }).unref();
  } catch (_) {}
  return { ok: true, via: 'powershell-fallback' };
}

// 新規セッションの起点候補（セッションに出てきた実在フォルダ）
function knownDirs(list) {
  const set = new Set();
  for (const s of list) for (const c of [s.launchCwd, s.latestCwd]) if (c && safeExists(c)) set.add(c);
  return [...set].sort();
}

// =============================================================
//  使用量 / レート制限（アカウント配列・2系統・常に新しい方を返す）
// -------------------------------------------------------------
//  各アカウントについて 2系統の値がありうる:
//   (a) Claude Code がそのアカウントの設定ファイルに残した cachedUsageUtilization
//       （読むだけ・無料だが古いことがある）
//   (b) 自前で GET /api/oauth/usage を叩いた値
//       （ステータス照会＝メッセージ枠は消費しない）
//  (b) は【有効なアクセストークンがあるアカウントだけ】。トークンは発行から
//  約8時間で失効し board は refresh しないので、非アクティブ側は実質いつも (a)。
//  取得は「前回取得以降に3回以上やり取り＋その後1時間放置」で自動1回、
//  または手動「更新」時のみ（API を使い過ぎない）。
//
//  ★★ トークンはこのサーバ内だけで扱い、レスポンス・ログ・エラー文字列の
//      どこにも出さない。外に返すオブジェクトは必ず下の pickPublic() で
//      フィールドを明示的に選んで組み立てること（丸ごと渡さない）。
// =============================================================
const STATE_FILE = path.join(DATA_DIR, 'status-state.json');
const AUTO_MIN_TURNS = 3;
const AUTO_IDLE_MS = 60 * 60 * 1000;      // 放置1時間
const AUTO_COOLDOWN_MS = 20 * 60 * 1000;  // 最低間隔（保険）
const FRESH_MS = 5 * 60 * 1000;           // これ以内なら「たった今」
const RECENT_MS = 2 * 60 * 60 * 1000;     // これ以内なら「少し前」・以降は【古い】
const KNOWN_KEEP_MS = 14 * 24 * 60 * 60 * 1000; // 設定から外れたアカウントを覚えておく期間

let statusState = null;
function loadState() {
  if (statusState) return statusState;
  try { statusState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { statusState = {}; }
  return statusState;
}
function saveState() { try { fs.writeFileSync(STATE_FILE, JSON.stringify(statusState)); } catch (_) {} }

// アカウント単位の記録を取り出す（無ければ作る）
function stateOf(uuid) {
  const st = loadState();
  st.accounts = st.accounts || {};
  st.accounts[uuid] = st.accounts[uuid] || {};
  return st.accounts[uuid];
}

// =============================================================
//  スロット(settings.accounts の key)の「入れ替わり」検知
// -------------------------------------------------------------
//  設定ファイルが指す実アカウント(accountUuid)を毎回読むのは resolveAccounts()
//  が既にやっているが、「前回と比べて変わったか」は保存しないと分からない。
//  ここは【スロットの位置】単位で記録する（アカウントUUID単位の stateOf とは別物）。
//  ~/.claude.json 等の固定パスに別人が /login し直すケースを検知するのが目的。
//  claude-anchor/profiles/<key>/ のようにアカウント専用の設定ファイルは
//  原理的に入れ替わらないので、ここでは呼ばない(呼び出し側で判断)。
// =============================================================
function slotIdentity(key) {
  const st = loadState();
  st.slots = st.slots || {};
  st.slots[key] = st.slots[key] || {};
  return st.slots[key];
}
const SWAP_BADGE_MS = 24 * 60 * 60 * 1000; // 見落とし防止のため検知後24時間は印を出し続ける
function checkSlotSwap(key, accountUuid, email) {
  const rec = slotIdentity(key);
  let swapped = false, swappedFrom = null, swappedAtMs = null;
  if (rec.accountUuid && accountUuid && rec.accountUuid !== accountUuid) {
    // 前回の記録と違うアカウントになっている＝入れ替わった
    swapped = true; swappedFrom = rec.email || null; swappedAtMs = Date.now();
    rec.swappedAtMs = swappedAtMs; rec.swappedFrom = swappedFrom;
  } else if (rec.swappedAtMs && (Date.now() - rec.swappedAtMs) < SWAP_BADGE_MS) {
    // 直近(24h以内)に検知済みなら、印を出し続ける
    swapped = true; swappedFrom = rec.swappedFrom || null; swappedAtMs = rec.swappedAtMs;
  }
  rec.accountUuid = accountUuid || rec.accountUuid || null;
  rec.email = email || rec.email || null;
  rec.lastSeenMs = Date.now();
  return { swapped, swappedFrom, swappedAtMs };
}

// 5時間枠のリセット時刻を取り出す（2つの使用量が「同じ枠」か照合するため）
function sessionResetAt(util) {
  if (!util) return null;
  const fromArr = Array.isArray(util.limits)
    ? (util.limits.find(l => l && l.kind === 'session') || {}).resets_at : null;
  const raw = fromArr || (util.five_hour && util.five_hour.resets_at) || null;
  const t = raw ? Date.parse(raw) : NaN;
  return isNaN(t) ? null : t;
}
// 同じ5時間枠か（取得タイミングの差で秒単位はズレるので余裕を持たせる）
function sameWindow(a, b) {
  const x = sessionResetAt(a), y = sessionResetAt(b);
  return !!(x && y && Math.abs(x - y) < 5 * 60 * 1000);
}

// 旧形状 {live,lastFetchAt,error,lastTryAt} → {accounts:{[uuid]:{...}}} へ（壊さず引き継ぐ）
function migrateState(activeUuid, activeCachedUtil) {
  const st = loadState();
  if (st.accounts) return;                      // 既に新形状
  const old = { live: st.live || null, lastFetchAt: st.lastFetchAt || 0,
                error: st.error || null, lastTryAt: st.lastTryAt || 0 };
  st.accounts = {};
  // 旧 live は「既定プロファイルの資格情報」で取った値だが、どのアカウントのもの
  // だったかはファイルに書かれていない。移行までの間にユーザーが既定アカウントを
  // 切り替えていると、他人の数値を貼ってしまう。
  // → 既定プロファイルのキャッシュと 5時間枠のリセット時刻が一致する時だけ引き継ぐ。
  //   確証が無ければ捨てる（誤ったアカウントに他人の残量を出すより、古い値を1回
  //   失う方がまし。次の取得ですぐ埋まる）。
  if (activeUuid && old.live && sameWindow(old.live.util, activeCachedUtil)) {
    st.accounts[activeUuid] = old;
  }
  delete st.live; delete st.lastFetchAt; delete st.error; delete st.lastTryAt;
  st.version = 2;
  saveState();
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(HOME, p.slice(2));
  return p;
}

const labelOfKind = k => ({ session: '5時間枠', weekly_all: '週次枠', weekly_opus: 'Opus週次', weekly_sonnet: 'Sonnet週次' }[k] || k);
// Max プランは model スコープ付きの週次枠(weekly_scoped)を返す。kind だけだと
// 「weekly_scoped」としか出ないので、scope のモデル名を拾って読める名前にする。
function labelOfLimit(l) {
  if (l && l.kind === 'weekly_scoped') {
    const m = l.scope && l.scope.model && (l.scope.model.display_name || l.scope.model.id);
    return m ? m + '週次' : 'モデル別週次';
  }
  return labelOfKind(l && l.kind);
}

// プラン種別（Max と Pro では同じ%でも実量が違うので必ず出す）
function planOf(oa) {
  if (!oa) return null;
  const t = String(oa.organizationType || '');
  const tier = String(oa.organizationRateLimitTier || '');
  let name = /max/i.test(t) ? 'Max' : /pro/i.test(t) ? 'Pro' : (t || null);
  const m = /max_(\d+)x/i.exec(tier);
  if (name === 'Max' && m) name = 'Max ' + m[1] + 'x';
  return name;
}

const KIND_ORDER = ['session', 'weekly_all', 'weekly_opus', 'weekly_sonnet', 'weekly_scoped'];

// ★ severity の単一ソース。フロントで別のしきい値を再定義しないこと。
//   戻り値は limits 配列（データが無ければ null）。
function normalizeUtil(util) {
  if (!util) return null;
  const now = Date.now();
  let src = Array.isArray(util.limits) ? util.limits : [];
  if (!src.length) { // limits 配列が無ければ five_hour / seven_day から作る
    const mk = (o, kind) => o ? { kind, percent: o.utilization, severity: null, resets_at: o.resets_at } : null;
    src = [mk(util.five_hour, 'session'), mk(util.seven_day, 'weekly_all')].filter(Boolean);
  }
  if (!src.length) return null;
  const limits = src.map(l => {
    const reset = l.resets_at ? new Date(l.resets_at).getTime() : null;
    const sev = l.severity || (l.percent >= 95 ? 'critical' : l.percent >= 80 ? 'warning' : 'normal');
    return { kind: l.kind, label: labelOfLimit(l), percent: l.percent, severity: sev,
      resetsAt: l.resets_at, resetInMs: reset ? Math.max(0, reset - now) : null, expired: reset ? reset < now : false };
  });
  limits.sort((a, b) => {
    const ia = KIND_ORDER.indexOf(a.kind), ib = KIND_ORDER.indexOf(b.kind);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return limits;
}

// 鮮度。古い値に「新鮮」と言わせないための単一の判定。
function freshnessOf(ageMs) {
  if (ageMs == null) return 'unknown';
  if (ageMs < FRESH_MS) return 'fresh';
  if (ageMs < RECENT_MS) return 'recent';
  return 'stale';
}

// エラーは短いコードだけにする（トークンやヘッダが紛れ込む余地を残さない）
function errCode(e) {
  const s = String((e && (e.code || e.message)) || 'error');
  return s.slice(0, 40);
}

// =============================================================
//  アカウント名簿 — claude-anchor/accounts.json が唯一の正
// -------------------------------------------------------------
//  cc.ps1 / switch.ps1 / anchor.ps1 などの切替スクリプト群と同じ名簿を読む。
//  盤面側で名簿を持つと増減のたびに二重管理になるので【読むだけ】。
//  これにより「まだログインしていないアカウント」も枠として出せる。
// =============================================================
//  ★"enabled": false は【一時無効化】。名簿から消さずに休ませる印で、
//    盤面では「居ないもの」として扱う（一覧に出さない・使用量も取りに行かない）。
//    資格情報は残っているので、名簿を true に戻せばそのまま復帰する。
function readRoster(anchorDirSetting) {
  if (!anchorDirSetting) return null;
  try {
    const j = readJsonFile(path.join(expandHome(anchorDirSetting), 'accounts.json'));
    if (!Array.isArray(j.accounts)) return null;
    const all = j.accounts.filter(a => a && a.email).map(a => ({
      key: a.key || null, email: String(a.email), plan: a.plan || null, label: a.label || null,
      enabled: a.enabled !== false,
    }));
    if (!all.length) return null;
    const off = all.filter(a => !a.enabled);
    return {
      primary: j.primary || null,
      list: all.filter(a => a.enabled),
      disabledMails: new Set(off.map(a => a.email.toLowerCase())),
      disabledKeys: new Set(off.map(a => a.key).filter(Boolean)),
    };
  } catch (_) { return null; }
}
const NO_ROSTER = { disabledMails: new Set(), disabledKeys: new Set() };

// 休止中の枠でも、その中身が「今開いているアカウント」なら残す
function restingKeepDir(anchorBase, dirName, activeUuid) {
  if (!activeUuid) return false;
  const c = readAccountConfig(path.join(anchorBase, 'profiles', dirName, '.claude.json'));
  return !!(c.ok && c.accountUuid === activeUuid);
}
const planLabel = p => (/max/i.test(p || '') ? 'Max' : /pro/i.test(p || '') ? 'Pro' : (p || null));

// アカウントの設定ファイルを読む（oauthAccount と使用量キャッシュ）
function readAccountConfig(file) {
  try {
    const j = readJsonFile(file);
    const oa = j.oauthAccount;
    if (!oa || !oa.accountUuid) return { ok: false, reason: 'no-account' };
    const cu = j.cachedUsageUtilization;
    const cached = (cu && cu.utilization) ? { util: cu.utilization, fetchedAtMs: cu.fetchedAtMs || null } : null;
    return { ok: true, accountUuid: oa.accountUuid, email: oa.emailAddress || null, plan: planOf(oa), cached };
  } catch (e) {
    return { ok: false, reason: (e && e.code === 'ENOENT') ? 'no-file' : 'bad-json' };
  }
}

// ★ 戻り値の token は絶対に外へ出さない。
//   空トークン / 期限切れなら token=null にして、ネットワークを呼ばせない。
function readCredential(file) {
  let o;
  try { o = readJsonFile(file).claudeAiOauth || {}; }
  catch (_) { return { auth: 'none', token: null, expiresAt: 0 }; }
  const token = typeof o.accessToken === 'string' ? o.accessToken : '';
  const expiresAt = Number(o.expiresAt) || 0;
  if (!token) return { auth: 'none', token: null, expiresAt: 0 };
  if (!(expiresAt > Date.now())) return { auth: 'expired', token: null, expiresAt };
  return { auth: 'ok', token, expiresAt };
}

// -------------------------------------------------------------
//  資格情報プール — 「両アカウント同時にライブ取得」を可能にする仕組み
// -------------------------------------------------------------
//  普段の .claude / .claude-b は「今ログインしている方」しか有効トークンを
//  持たないので、非アクティブ側はキャッシュ表示しかできなかった。
//  一方 claude-anchor の profiles\<key>\ は【アカウント毎に独立してログイン済み】で、
//  refresh token により自動更新される。ここを資格情報の供給源として使えば
//  両方を同時にライブ取得できる。
//
//  ★ 安全のため accountUuid が一致する時だけ使う。
//    （他人のトークンで別アカウントを問い合わせることが原理的に起きない）
//  ★ プールは Map<accountUuid, {token, expiresAt, from}>。token は外へ出さない。
// -------------------------------------------------------------
function credentialPool(settings) {
  const pool = new Map();
  const add = (uuid, cred, from) => {
    if (!uuid || !cred || !cred.token) return;
    const prev = pool.get(uuid);
    // 同じアカウントに複数あるなら、期限が一番遠いものを使う
    if (!prev || cred.expiresAt > prev.expiresAt) pool.set(uuid, { token: cred.token, expiresAt: cred.expiresAt, from });
  };

  // (1) 設定に書かれた各スロット（従来の供給源）
  // ★ 空配列 [] は「ユーザーが全部削除した」という意味のある状態なので、
  //   キー自体が無い(undefined)時だけ既定にフォールバックする(空配列を既定で
  //   上書きすると「0件」に到達できなくなるバグがあった)。
  const slots = Array.isArray(settings.accounts) ? settings.accounts : DEFAULT_BOARD.settings.accounts;
  for (const slot of slots) {
    if (!slot) continue;
    const cfg = readAccountConfig(expandHome(slot.configFile));
    if (!cfg.ok) continue;
    add(cfg.accountUuid, readCredential(expandHome(slot.credFile)), 'slot:' + (slot.key || '?'));
  }

  // (2) アンカー用プロファイル（アカウント毎に常時ログイン済み）
  const base = settings.anchorDir ? expandHome(settings.anchorDir) : null;
  if (base) {
    let dirs = [];
    try { dirs = fs.readdirSync(path.join(base, 'profiles'), { withFileTypes: true }); } catch (_) {}
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const pdir = path.join(base, 'profiles', d.name);
      const cfg = readAccountConfig(path.join(pdir, '.claude.json'));
      if (!cfg.ok) continue;
      add(cfg.accountUuid, readCredential(path.join(pdir, '.credentials.json')), 'anchor:' + d.name);
    }
  }
  return pool;
}

// ステータス照会（メッセージ枠は消費しない）。トークンはここだけで使う。
function fetchLiveUsage(token) {
  return new Promise((resolve, reject) => {
    if (!token) return reject(new Error('no-token'));
    const req = https.request({ host: 'api.anthropic.com', path: '/api/oauth/usage', method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20', 'Accept': 'application/json', 'User-Agent': 'session-board' } },
      res => {
        let b = ''; res.on('data', d => b += d); res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error('http-' + res.statusCode));
          try { const j = JSON.parse(b); resolve(j.utilization || j); } catch (e) { reject(new Error('parse')); }
        });
      });
    req.on('error', e => reject(new Error(errCode(e))));
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function doLiveFetch(acc) {
  const s = stateOf(acc.accountUuid);
  s.lastTryAt = Date.now();
  try {
    const util = await fetchLiveUsage(acc._token);
    s.live = { util, fetchedAtMs: Date.now() };
    s.lastFetchAt = Date.now(); s.error = null;
    saveState(); return true;
  } catch (e) { s.error = errCode(e); saveState(); return false; }
}

// =============================================================
//  朝8時アンカーの状態（読むだけ）
// -------------------------------------------------------------
//  claude-anchor は平日8:00に各アカウントを1回叩いて5時間枠の起点を揃える。
//  2026-07-09〜08-14 の27日間、トークン未設定のまま空打ちし続けたのに
//  タスクの LastTaskResult は 0（成功）だったため誰も気づかなかった。
//  → 毎日見るこの盤面に出すのが再発防止の本体。
//  真値は anchor.ps1 が書く anchor-status.json。最後に成功した日だけは
//  履歴が要るので anchor.log から拾う。
// =============================================================
// PowerShell 5.1 の Set-Content -Encoding UTF8 は BOM 付きで書く。
// 先頭の U+FEFF が残っていると JSON.parse が落ちるので剥がす。
function readJsonFile(file) {
  let s = fs.readFileSync(file, 'utf8');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  return JSON.parse(s);
}

// アンカー用プロファイルが「今」ログイン済みかを直接見る。
// ★ 前回の実行記録ではなく профиль 実体を見るのが要点:
//   ログイン直後はまだアンカーが走っていないので記録は SETUP のままだが、
//   もう手当ては済んでいる。記録だけ見ているとボタンが消えない。
// ★ トークンは真偽値にしてから返す（値は外に出さない）。
function readAnchorProfile(base, key) {
  const dir = path.join(base, 'profiles', key);
  const out = { loggedIn: false, profileEmail: null };
  try {
    const o = readJsonFile(path.join(dir, '.credentials.json')).claudeAiOauth || {};
    out.loggedIn = !!(o.accessToken && String(o.accessToken).length > 0);
  } catch (_) {}
  try {
    const j = readJsonFile(path.join(dir, '.claude.json'));
    if (j.oauthAccount && j.oauthAccount.emailAddress) out.profileEmail = j.oauthAccount.emailAddress;
  } catch (_) {}
  return out;
}

// 平日8:00のタスクなので、金→月の3日空きが正常の最大。4日空いたら止まっている。
const ANCHOR_GAP_MS = 4 * 24 * 60 * 60 * 1000;

function readAnchor(dirSetting) {
  if (!dirSetting) return null;
  const base = expandHome(dirSetting);
  const out = { available: false, state: 'ok', dir: base, accounts: [] };

  // 休止中(名簿の enabled:false)は「打てていない」ではなく「打たない」。
  // 記録には前回までの結果が残っているので、ここで落とさないと赤いままになる。
  const off = readRoster(dirSetting) || NO_ROSTER;
  const isOff = (key, mail) => !!((key && off.disabledKeys.has(key))
    || (mail && off.disabledMails.has(String(mail).toLowerCase())));

  let j0 = null;
  try {
    const j = readJsonFile(path.join(base, 'anchor-status.json'));
    j0 = j;
    out.available = true;
    out.ranAtMs = j.ranAtMs || null;
    out.accounts = (Array.isArray(j.accounts) ? j.accounts : []).map(a => ({
      key: a.key || null, email: a.email || null, actual: a.actual || null,
      state: a.state || 'unknown', msg: a.msg || null,
    })).filter(a => !isOff(a.key, a.email));
  } catch (_) { /* 未生成＝まだ一度も v4 が走っていない */ }

  // 記録に無くても profiles/ にあるものは拾う（記録より実体を優先）
  try {
    for (const d of fs.readdirSync(path.join(base, 'profiles'), { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      if (out.accounts.some(a => a.key === d.name)) continue;
      if (isOff(d.name, null)) continue;
      out.accounts.push({ key: d.name, email: null, actual: null, state: 'unknown', msg: null });
    }
  } catch (_) {}

  // 各アカウントの「今」の実体を重ねる
  for (const a of out.accounts) {
    if (!a.key) continue;
    const p = readAnchorProfile(base, a.key);
    a.loggedIn = p.loggedIn;
    a.profileEmail = p.profileEmail;
    if (!a.email && p.profileEmail) a.email = p.profileEmail;
    // 枠の名前と中身が違っても異常ではない。走行中に /login で乗り換えるのは
    // 普通の操作で、accounts.json にもそう書いてある。表示用に残すだけで、
    // これを理由に警告は出さない（「取り違えています」は利用者に意味が通じない）。
    a.mismatch = !!(p.profileEmail && a.email && p.profileEmail !== a.email);
  }

  // ---- 異常だけを拾う。何も無ければ盤面には出さない ----
  const issues = [];
  if (out.accounts.some(a => !a.loggedIn)) issues.push('setup');
  // 本当に困るのは「名簿のアカウントがどの枠にも入っていない」＝打てない場合だけ。
  // anchor.ps1 が coverage を書くので、それがあるときはそれで判定する。
  out.missing = Array.isArray(j0 && j0.coverage)
    ? j0.coverage.filter(c => !c.anchored && !isOff(null, c.email)).map(c => c.email)
    : [];
  if (out.missing.length) issues.push('missing');
  // 記録上の失敗は「ログイン済みなのに失敗している」時だけ意味がある
  if (out.accounts.some(a => a.loggedIn && a.state === 'FAIL')) issues.push('fail');
  // タスク自体が止まっていないか（記録がある時だけ判定できる）
  if (out.available && out.ranAtMs && (Date.now() - out.ranAtMs) > ANCHOR_GAP_MS
      && out.accounts.every(a => a.loggedIn)) issues.push('stale');

  out.issues = issues;
  out.show = issues.length > 0;
  out.state = issues.includes('missing') ? 'missing'
            : issues.includes('setup') ? 'setup'
            : issues.includes('fail')  ? 'fail'
            : issues.includes('stale') ? 'stale' : 'ok';

  // 最後に成功した時刻（v3/v4 どちらのログ形式でも拾える形で）
  try {
    const log = fs.readFileSync(path.join(base, 'anchor.log'), 'utf8');
    const re = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+\[[^\]]*\]\s+OK\b/gm;
    let m, last = null;
    while ((m = re.exec(log))) last = m[1];
    if (last) {
      const t = Date.parse(last.replace(' ', 'T'));
      if (!isNaN(t)) out.lastOkMs = t;
    }
  } catch (_) {}

  const now = Date.now();
  out.lastOkAgeMs = out.lastOkMs ? now - out.lastOkMs : null;
  out.lastOkDays = out.lastOkMs ? Math.floor(out.lastOkAgeMs / 86400000) : null;
  out.ranAgeMs = out.ranAtMs ? now - out.ranAtMs : null;
  return out;
}

// -------------------------------------------------------------
//  アンカーの操作（盤面のボタンから）
// -------------------------------------------------------------
//  ログインは対話が要る（/login → ブラウザで承認 → /exit）ので、
//  サーバは「端末を1枚開いて所定のスクリプトを走らせる」までを担う。
//  ★ §8-5 と同じ作法: 配列引数・shell:false・自由入力を -Command に混ぜない。
//    key は anchor 自身が知っているキーだけを許可（許可リスト照合）。
// -------------------------------------------------------------
function anchorBase(settings) {
  const d = settings && settings.anchorDir;
  if (!d) return null;
  const base = expandHome(d);
  return safeExists(base) ? base : null;
}
function allowedAnchorKeys(base) {
  // 休止中のアカウントは、盤面のボタンからは触らせない（名簿を戻せば復活する）
  const off = readRoster(base) || NO_ROSTER;
  try {
    const j = readJsonFile(path.join(base, 'anchor-status.json'));
    return (j.accounts || []).map(a => a && a.key)
      .filter(k => typeof k === 'string' && /^[A-Za-z0-9_-]{1,20}$/.test(k))
      .filter(k => !off.disabledKeys.has(k));
  } catch (_) { return []; }
}
// 端末を1枚開いて PowerShell スクリプトを走らせる（-NoExit で結果を読ませる）
function launchPsScript(base, script, extraArgs, title) {
  const full = path.join(base, script);
  if (!safeExists(full)) return { ok: false, error: script + ' が見つかりません' };
  const psArgs = ['-NoExit', '-NoProfile', '-File', full, ...extraArgs];
  const fallback = () => {
    try {
      spawn('powershell.exe', psArgs, { cwd: base, stdio: 'ignore', detached: true, shell: false }).unref();
      return { ok: true, via: 'powershell-fallback' };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  };
  try {
    const p = spawn('wt.exe', ['-w', '0', 'new-tab', '-d', base, '--title', title, 'powershell', ...psArgs],
      { stdio: 'ignore', detached: true, shell: false });
    p.on('error', () => fallback());
    p.unref();
    return { ok: true, via: 'wt' };
  } catch (_) { return fallback(); }
}

// -------------------------------------------------------------
//  設定 → アカウント一覧（内部形。_token を持つので外へ出さない）
// -------------------------------------------------------------
function resolveAccounts(settings) {
  // ★ credentialPool と同じ理由で、空配列は既定にフォールバックしない(判断B/バグ修正)。
  const slots = Array.isArray(settings.accounts) ? settings.accounts : DEFAULT_BOARD.settings.accounts;

  // ★ 今どのアカウントで `claude` が開くか＝home root の設定の accountUuid。
  //   email ではなく UUID で一致を見る（email変更・同一email・org複数に強い）。
  const activeCfg = readAccountConfig(ACTIVE_CONFIG_FILE);
  const activeUuid = activeCfg.ok ? activeCfg.accountUuid : null;
  // ★ 下の「過去に見たアカウント」走査より前に新形状へ
  migrateState(activeUuid, activeCfg.ok ? (activeCfg.cached && activeCfg.cached.util) : null);

  // 名簿は最初に読む。休止中(enabled:false)のアカウントを、集める前に落とすため
  const roster = readRoster(settings.anchorDir);
  const off = roster || NO_ROSTER;
  //  ★ただし「今まさに開いているアカウント」だけは、休止中でも隠さない。
  //    見えないのに動いている、という一番わかりにくい状態を作らないため。
  const restingMail = (mail) => !!(mail && off.disabledMails.has(String(mail).toLowerCase()));

  // アカウント単位の資格情報（アンカー用プロファイルも含む＝両方同時に取れる）
  const pool = credentialPool(settings);

  const list = [];
  const byUuid = new Map();
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i] || {};
    const configFile = expandHome(slot.configFile);
    const credFile = expandHome(slot.credFile);
    const key = slot.key || ('slot' + i);
    const accent = slot.accent || 'blue';
    const label = (slot.label && String(slot.label).trim()) || null;
    const cfg = readAccountConfig(configFile);
    // 休止中のアカウントは一覧から外す（開いている本人だけは残す）
    if (cfg.ok && restingMail(cfg.email) && cfg.accountUuid !== activeUuid) continue;

    if (!cfg.ok) { // 設定が無い/壊れている → そのアカウントだけ状態化して他は続行
      list.push({ key, accent, label, configured: true, available: false, configFile,
                  source: 'missing', auth: 'none', reason: cfg.reason,
                  accountUuid: null, email: null, active: false, limits: null,
                  fetchedAtMs: null, error: null, _token: null, inBoard: true });
      continue;
    }

    const prev = byUuid.get(cfg.accountUuid);
    if (prev) { // 2スロットが同じアカウントを指している → 1つにまとめる
      prev.slots.push(key);
      if (configFile === ACTIVE_CONFIG_FILE) { prev.key = key; prev.accent = accent; prev.label = label; }
      continue;
    }

    // このアカウント宛の資格情報をプールから引く（UUID一致のものだけ）
    const own = readCredential(credFile);
    const best = pool.get(cfg.accountUuid) || null;
    const token = best ? best.token : own.token;
    const auth = token ? 'ok' : own.auth;
    // ★ このスロット(固定パス)の中身が前回と違うアカウントになっていないか(判断B)。
    //   claude-anchor/profiles 経由(下のループ)はアカウント専用ファイルなので対象外。
    const swap = checkSlotSwap(key, cfg.accountUuid, cfg.email);
    const acc = {
      key, accent, label, slots: [key], configured: true, available: true, configFile,
      accountUuid: cfg.accountUuid, email: cfg.email, plan: cfg.plan || null,
      active: cfg.accountUuid === activeUuid,
      cached: cfg.cached, auth, _token: token,
      tokenFrom: best ? best.from : (own.token ? 'slot:' + key : null),
      inBoard: true, swapped: swap.swapped, swappedFrom: swap.swappedFrom, swappedAtMs: swap.swappedAtMs,
    };
    list.push(acc);
    byUuid.set(cfg.accountUuid, acc);
  }

  // アンカー用プロファイルもアカウントの供給源にする。
  // これらは【アカウント毎に独立してログイン済み】なので、既定プロファイルを
  // どちらに切り替えていても両方のアカウントが常に出せる（かつライブで取れる）。
  const abase = settings.anchorDir ? expandHome(settings.anchorDir) : null;
  if (abase) {
    let dirs = [];
    try { dirs = fs.readdirSync(path.join(abase, 'profiles'), { withFileTypes: true }); } catch (_) {}
    const usedAccents = new Set(list.map(a => a.accent));
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      if (off.disabledKeys.has(d.name) && !restingKeepDir(abase, d.name, activeUuid)) continue;   // 休止中の枠は見ない
      const pdir = path.join(abase, 'profiles', d.name);
      const cfg = readAccountConfig(path.join(pdir, '.claude.json'));
      if (!cfg.ok) continue;
      if (restingMail(cfg.email) && cfg.accountUuid !== activeUuid) continue;   // 休止中のアカウント
      const prev = byUuid.get(cfg.accountUuid);
      if (prev) {                       // 既にスロットで出ている → キャッシュだけ補う
        if (!prev.cached && cfg.cached) prev.cached = cfg.cached;
        continue;
      }
      const best = pool.get(cfg.accountUuid) || null;
      // 3アカウント以上でも色が衝突しないよう、空いている色から順に取る
      const PALETTE = ['purple', 'green', 'amber', 'blue'];
      const accent = PALETTE.find(c => !usedAccents.has(c)) || 'gray';
      usedAccents.add(accent);
      const acc = {
        key: 'anchor-' + d.name, accent, label: null, slots: [], configured: true,
        available: true, configFile: path.join(pdir, '.claude.json'),
        accountUuid: cfg.accountUuid, email: cfg.email, plan: cfg.plan || null,
        active: cfg.accountUuid === activeUuid,
        cached: cfg.cached, auth: best ? 'ok' : 'none', _token: best ? best.token : null,
        tokenFrom: best ? best.from : null, fromAnchor: true,
        // board.json の settings.accounts には無い＝自動混入(判断A)。「登録」ボタンの対象。
        inBoard: false, rosterKey: null,
      };
      list.push(acc);
      byUuid.set(cfg.accountUuid, acc);
    }
  }

  // 設定からは外れたが、過去に見た（＝記録が残っている）アカウントも出す。
  // 既定プロファイルを別アカウントに切り替えると両スロットが同じアカウントを
  // 指すことがあり、その時に「もう片方の残量」が消えてしまうのを防ぐ。
  const st = loadState();
  for (const [uuid, s] of Object.entries(st.accounts || {})) {
    if (byUuid.has(uuid)) continue;
    if (restingMail(s.email) && uuid !== activeUuid) continue;   // 休止中のアカウント
    if (!s.live || !s.live.util) continue;
    const at = s.live.fetchedAtMs || 0;
    if (!at || Date.now() - at > KNOWN_KEEP_MS) continue;
    const best = pool.get(uuid) || null;
    list.push({ key: 'known-' + uuid.slice(0, 4), accent: 'gray', slots: [], configured: false,
                available: true, accountUuid: uuid, email: s.email || null, label: null,
                active: uuid === activeUuid, cached: null,
                auth: best ? 'ok' : 'none', _token: best ? best.token : null,
                tokenFrom: best ? best.from : null, inBoard: false });
  }

  // --- 名簿と突き合わせる（未ログインのアカウントも枠として出す）---
  if (roster) {
    const byMail = new Map(list.filter(a => a.email).map(a => [a.email.toLowerCase(), a]));
    const usedAccents2 = new Set(list.map(a => a.accent));
    const PALETTE2 = ['blue', 'purple', 'green', 'amber'];
    for (const r of roster.list) {
      const hit = byMail.get(r.email.toLowerCase());
      if (hit) {                       // 既に出ている → 名簿の情報で補強
        hit.rosterKey = r.key;
        hit.primary = !!(roster.primary && r.key === roster.primary);
        if (!hit.plan) hit.plan = planLabel(r.plan);
        continue;
      }
      // まだどこにもログインしていないアカウント → 「未ログイン」枠として出す
      const accent = PALETTE2.find(c => !usedAccents2.has(c)) || 'gray';
      usedAccents2.add(accent);
      list.push({
        key: 'roster-' + (r.key || r.email), accent, label: null, slots: [], configured: true,
        available: true,                 // 枠としては有効（データが無いだけ）→「未ログイン」と出る
        accountUuid: null, email: r.email, plan: planLabel(r.plan),
        active: false, cached: null, auth: 'none', _token: null,
        rosterKey: r.key, primary: !!(roster.primary && r.key === roster.primary),
        inBoard: false,
      });
    }
  }

  // アクティブ → データがあるもの → 未ログイン、の順に並べる
  const rank = a => (a.active ? 0 : (a.auth === 'ok' || a.cached ? 1 : 2));
  list.sort((a, b) => rank(a) - rank(b));
  return { list, activeUuid, activeEmail: activeCfg.ok ? activeCfg.email : null };
}

// -------------------------------------------------------------
//  内部形 → レスポンス（★フィールドを明示的に選ぶ。丸ごと渡さない）
// -------------------------------------------------------------
function pickPublic(acc) {
  const now = Date.now();
  const s = acc.accountUuid ? stateOf(acc.accountUuid) : {};
  const liveAt = (s.live && s.live.fetchedAtMs) ? s.live.fetchedAtMs : -1;
  const cacheAt = (acc.cached && acc.cached.fetchedAtMs) ? acc.cached.fetchedAtMs : -1;

  let limits = null, source = null, fetchedAtMs = null;
  if (s.live && liveAt >= cacheAt) { limits = normalizeUtil(s.live.util); source = 'live'; fetchedAtMs = liveAt; }
  if (!limits && acc.cached) { limits = normalizeUtil(acc.cached.util); source = 'cache'; fetchedAtMs = cacheAt > 0 ? cacheAt : null; }
  if (!limits) {                     // データがまだ1つも無い
    source = acc.available ? (acc.auth === 'ok' ? 'empty' : 'unauth') : 'missing';
    fetchedAtMs = null;
  }
  const ageMs = fetchedAtMs ? now - fetchedAtMs : null;

  return {
    key: acc.key, accountUuid: acc.accountUuid, email: acc.email, plan: acc.plan || null, accent: acc.accent, label: acc.label || null,
    rosterKey: acc.rosterKey || null, primary: !!acc.primary,
    active: !!acc.active, configured: !!acc.configured, available: !!acc.available && !!limits,
    source, auth: acc.auth, reason: acc.reason || null, configFile: acc.configFile || null,
    tokenFrom: acc.tokenFrom || null,   // どこの資格情報で取れたか（値ではなく出所だけ）
    fromAnchor: !!acc.fromAnchor,
    fetchedAtMs, ageMs, freshness: freshnessOf(ageMs),
    limits: limits || [],
    error: s.error || null, lastTryAt: s.lastTryAt || null,
    slots: acc.slots || [],
    // ★ board.json の settings.accounts に実登録されているか(判断A)。
    //   false は「名簿/アンカーから自動的に混ざっているだけ」＝管理画面の「登録」対象。
    inBoard: !!acc.inBoard,
    // ★ このスロットの中身が入れ替わっていないか(判断B)。inBoard のスロットのみ意味を持つ。
    swapped: !!acc.swapped, swappedFrom: acc.swappedFrom || null, swappedAtMs: acc.swappedAtMs || null,
  };
}

// 直近の使用状況（アカウント配列）＋自動更新トリガの評価
async function getStatus(board, sessions, forceRefresh) {
  const now = Date.now();
  const { list, activeUuid, activeEmail } = resolveAccounts(board.settings);  // 中で移行も走る

  // --- 自動更新トリガ（基準はアクティブ側の前回取得）---
  const activeSt = activeUuid ? stateOf(activeUuid) : {};
  const since = activeSt.lastFetchAt || 0;
  let latest = 0, turns = 0;
  for (const s of (sessions || [])) {
    if (s.lastTs) latest = Math.max(latest, Date.parse(s.lastTs));
    for (const t of (s.userTurnTimes || [])) if (Date.parse(t) > since) turns++;
  }
  const idleMs = latest ? now - latest : Infinity;
  const cooldownOk = now - since >= AUTO_COOLDOWN_MS;
  const triggered = turns >= AUTO_MIN_TURNS && idleMs >= AUTO_IDLE_MS && cooldownOk;

  // --- ライブ取得: 有効トークンがあるものだけ・並列（逐次awaitだと最悪16秒）---
  if (forceRefresh || triggered) {
    const targets = list.filter(a => a.accountUuid && a._token);
    if (targets.length) await Promise.allSettled(targets.map(a => doLiveFetch(a)));
  }

  // 表示用に email を覚えておく（設定から外れた後も名前を出せるように）
  for (const a of list) if (a.accountUuid && a.email) stateOf(a.accountUuid).email = a.email;
  saveState();

  return {
    accounts: list.map(pickPublic),
    anchor: readAnchor(board.settings.anchorDir),
    activeUuid, activeEmail, generatedAt: now,
    auto: {
      turnsSinceFetch: (isFinite(turns) ? turns : 0),
      idleMinutes: isFinite(idleMs) ? Math.round(idleMs / 60000) : null,
      minTurns: AUTO_MIN_TURNS, idleNeededMin: AUTO_IDLE_MS / 60000,
      justRefreshed: !!(forceRefresh || triggered),
    },
  };
}

// =============================================================
//  HTTP サーバ
// =============================================================
function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true; // curl 等（Originなし）は許可
  return o === `http://${HOST}:${PORT}` || o === `http://localhost:${PORT}`;
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = rel.split('?')[0];
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': STATIC_TYPES[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = u.pathname;
  try {
    // このポートに居るのが「このアプリ」かどうかを確かめるための口。
    // 二重起動判定(listenWithFallback)・配布物の自己確認に使う。
    // ★この応答の形は変えないこと(起動時の判定・QAが壊れる)。
    if (req.method === 'GET' && p === '/api/whoami') {
      return sendJson(res, 200, { app: 'claude-session-board', api: 1 });
    }
    if (req.method === 'GET' && p === '/api/sessions') {
      const board = loadBoard();
      const list = buildList(board);
      list.forEach(s => delete s.userTurnTimes);   // サーバ内部用フィールドは送らない
      return sendJson(res, 200, { sessions: list, settings: board.settings, wtResolvable, knownDirs: knownDirs(list), home: os.homedir(), boardHealth: boardHealthForResponse() });
    }
    if (req.method === 'GET' && p === '/api/preview') {
      return sendJson(res, 200, buildPreview(u.searchParams.get('id') || ''));
    }
    if (req.method === 'GET' && p === '/api/status') {
      const board = loadBoard();
      const status = await getStatus(board, scanSessions(board));
      status.boardHealth = boardHealthForResponse();
      return sendJson(res, 200, status);
    }
    if (req.method === 'POST') {
      if (!sameOrigin(req)) { return sendJson(res, 403, { error: 'cross-origin' }); }
      const body = await readBody(req);
      const board = loadBoard();

      if (p === '/api/pin') {
        const { sessionId, pinned, name } = body;
        if (!sessionId) return sendJson(res, 400, { error: 'sessionId required' });
        const cur = board.pins[sessionId] || {};
        if (pinned !== undefined) cur.pinned = !!pinned;
        if (name !== undefined) cur.name = name || undefined;
        if (!cur.pinned && !cur.name && !cur.group) delete board.pins[sessionId];
        else board.pins[sessionId] = cur;
        saveBoard(board);
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/name') {
        const { sessionId, name } = body;
        if (!sessionId) return sendJson(res, 400, { error: 'sessionId required' });
        const cur = board.pins[sessionId] || {};
        cur.name = (name && name.trim()) ? name.trim() : undefined;
        if (!cur.pinned && !cur.name && !cur.group) delete board.pins[sessionId];
        else board.pins[sessionId] = cur;
        saveBoard(board);
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/new') {
        const cwd = (body.cwd && String(body.cwd).trim()) || os.homedir();
        if (!safeExists(cwd)) return sendJson(res, 400, { error: 'フォルダが見つかりません: ' + cwd });
        return sendJson(res, 200, launchNew(cwd));
      }
      if (p === '/api/status/refresh') {   // 手動更新（新鮮値を1回取得。枠は消費しない）
        const st = await getStatus(board, scanSessions(board), true);
        st.boardHealth = boardHealthForResponse();
        return sendJson(res, 200, st);
      }
      // ===========================================================
      //  アカウント管理（board.json settings.accounts の追加/削除/並べ替え）
      // -----------------------------------------------------------
      //  ★ claude-anchor/accounts.json(名簿)は読むだけで一切書き換えない(判断A)。
      //    ここで触るのはあくまで盤面側の「どこを見に行くか」の登録簿。
      // ===========================================================
      if (p === '/api/accounts/add') {
        const accounts = Array.isArray(board.settings.accounts) ? board.settings.accounts.slice() : [];
        let { key, configFile, credFile, label, accent, rosterKey } = body;
        if (rosterKey && (!configFile || !credFile)) {
          // 名簿にあるが未登録のアカウントの「ワンクリック追加」:
          // アンカーの規約どおり claude-anchor/profiles/<rosterKey>/ を指す。
          if (!board.settings.anchorDir) return sendJson(res, 400, { error: 'anchorDir が設定されていません' });
          const base = expandHome(board.settings.anchorDir);
          configFile = configFile || path.join(base, 'profiles', String(rosterKey), '.claude.json');
          credFile = credFile || path.join(base, 'profiles', String(rosterKey), '.credentials.json');
          key = key || String(rosterKey);
        }
        key = (key && String(key).trim()) || '';
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(key)) return sendJson(res, 400, { error: '不正な key です（英数・-・_のみ、32文字まで）' });
        if (accounts.some(a => a && a.key === key)) return sendJson(res, 400, { error: 'その key は既に登録されています: ' + key });
        configFile = (configFile && String(configFile).trim()) || '';
        credFile = (credFile && String(credFile).trim()) || '';
        if (!configFile || !credFile) return sendJson(res, 400, { error: 'configFile と credFile は必須です' });
        const usedAccents = new Set(accounts.map(a => a && a.accent).filter(Boolean));
        const PALETTE = ['blue', 'purple', 'green', 'amber'];
        accent = (accent && String(accent).trim()) || PALETTE.find(c => !usedAccents.has(c)) || 'gray';
        label = (label && String(label).trim()) || '';
        accounts.push({ key, configFile, credFile, accent, label });
        board.settings.accounts = accounts;
        saveBoard(board);
        const reread = loadBoard(); // 保存できたはずで終わらせず、書いたファイルを読み直して返す
        return sendJson(res, 200, { ok: true, accounts: reread.settings.accounts });
      }
      if (p === '/api/accounts/remove') {
        const key = body.key && String(body.key);
        if (!key) return sendJson(res, 400, { error: 'key required' });
        const accounts = Array.isArray(board.settings.accounts) ? board.settings.accounts : [];
        const next = accounts.filter(a => !(a && a.key === key));
        if (next.length === accounts.length) return sendJson(res, 400, { error: '見つかりません: ' + key });
        board.settings.accounts = next; // 空配列(0件)も正しい状態として保存できる（バグ修正済み）
        saveBoard(board);
        const reread = loadBoard();
        return sendJson(res, 200, { ok: true, accounts: reread.settings.accounts });
      }
      if (p === '/api/accounts/reorder') {
        const order = Array.isArray(body.order) ? body.order.map(String) : null;
        if (!order) return sendJson(res, 400, { error: 'order (array) required' });
        const accounts = Array.isArray(board.settings.accounts) ? board.settings.accounts : [];
        const byKey = new Map(accounts.map(a => [a && a.key, a]));
        const next = [];
        for (const k of order) { const a = byKey.get(k); if (a) { next.push(a); byKey.delete(k); } }
        for (const a of byKey.values()) next.push(a); // 指定に無かったものは末尾に残す（消さない）
        board.settings.accounts = next;
        saveBoard(board);
        const reread = loadBoard();
        return sendJson(res, 200, { ok: true, accounts: reread.settings.accounts });
      }
      if (p === '/api/anchor/setup') {     // アンカー用プロファイルへログイン（対話・端末が開く）
        const base = anchorBase(board.settings);
        if (!base) return sendJson(res, 400, { error: 'anchorDir が見つかりません' });
        const key = String(body.key || '');
        const allow = allowedAnchorKeys(base);
        if (!allow.length) return sendJson(res, 400, { error: 'anchor-status.json が無く、対象アカウントが判りません' });
        if (!allow.includes(key)) return sendJson(res, 400, { error: '不明なアカウントキーです: ' + key });
        return sendJson(res, 200, launchPsScript(base, 'setup-account.ps1', [key], 'anchor setup: ' + key));
      }
      if (p === '/api/load' || p === '/api/load-bulk') {
        const ids = p === '/api/load' ? [body.sessionId] : (body.sessionIds || []);
        const dry = !!body.dryRun;
        const max = board.settings.maxBulkOpen;
        if (ids.length === 0) return sendJson(res, 400, { error: 'no session' });
        if (ids.length > max) return sendJson(res, 400, { error: `上限${max}件を超えています(${ids.length})` });

        const list = buildList(board);
        const byId = new Map(list.map(s => [s.sessionId, s]));
        const tabs = [];
        for (const id of ids) {
          const s = byId.get(id);
          if (!s || s.missing || !s.launchCwd) continue;
          tabs.push({ cwd: s.launchCwd, title: (s.title || id).slice(0, 40), sessionId: id });
        }
        if (tabs.length === 0) return sendJson(res, 400, { error: '開けるセッションがありません(cwd消失など)' });
        if (dry) return sendJson(res, 200, { ok: true, dryRun: dryRunString(tabs), count: tabs.length });
        const r = launchTabs(tabs);
        return sendJson(res, 200, r);
      }
    }
    // 静的ファイル
    if (req.method === 'GET') return serveStatic(req, res, p);
    res.writeHead(404); res.end('not found');
  } catch (e) {
    sendJson(res, 500, { error: String(e && e.message || e) });
  }
});

// ── 画面を開く ─────────────────────────────────────────────
// 「アプリモード」(--app=)で開けるブラウザがあれば、タブ無しの独立した窓で開く
// (タスクバーにこのアプリ自身のアイコンが出る)。見つからなければ既定のブラウザ。
// NO_BROWSER(既存・schtasks起動などで使用中)・CSB_NO_OPEN(今回追加。検証/自動テスト用)
// のどちらでも抑止できる。
const APP_MODE_BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
function findAppModeBrowser() {
  for (const b of APP_MODE_BROWSERS) {
    try { if (fs.existsSync(b)) return b; } catch (_) { /* 次を見る */ }
  }
  return null;
}
function openBrowser(url) {
  if (process.env.NO_BROWSER || process.env.CSB_NO_OPEN) return; // テスト時などブラウザを開かない
  const browser = findAppModeBrowser();
  if (browser) {
    try {
      const child = spawn(browser, [`--app=${url}`, '--window-size=1280,860'],
        { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      return;
    } catch (_) { /* 既定ブラウザにフォールバック */ }
  }
  try { spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true, shell: false }).unref(); }
  catch (_) {}
}

// ── ポートが埋まっていたときの振る舞い ─────────────────────────
// 1. そのポートに「このアプリ自身」が既に居るか /api/whoami で確かめる
//    → 居れば新しいプロセスは立てず、ブラウザだけ開いて終わる(二重起動防止)。
// 2. 別の何かが使っているだけなら、空いている番号を順に10個まで試す。
// 3. どれも駄目なら諦めて理由を出す。
const MAX_PORT_TRIES = 10;
function probeSelf(port) {
  return new Promise(resolve => {
    const req = http.get({ host: HOST, port, path: '/api/whoami', timeout: 1200 }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve(res.statusCode === 200 && j && j.app === 'claude-session-board');
        } catch (_) { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
async function listenWithFallback(startPort) {
  if (await probeSelf(startPort)) {
    const url = `http://${HOST}:${startPort}/`;
    console.log('すでに起動しています。ブラウザを開きます。');
    openBrowser(url);
    setTimeout(() => process.exit(0), 500);
    return null;
  }
  for (let i = 0; i < MAX_PORT_TRIES; i++) {
    const port = startPort + i;
    const ok = await new Promise(resolve => {
      const onError = (err) => {
        if (err && err.code === 'EADDRINUSE') resolve(null);
        else { console.error('起動できませんでした: ' + (err && err.message || err)); process.exit(1); }
      };
      server.once('error', onError);
      server.listen(port, HOST, () => { server.removeListener('error', onError); resolve(port); });
    });
    if (ok) {
      if (i > 0) console.log(`ポート ${startPort} は別のものが使っていたので、${port} で起動しました。`);
      return port;
    }
  }
  console.error(`ポート ${startPort} から ${startPort + MAX_PORT_TRIES - 1} まで、すべて使われていました。`);
  console.error('環境変数 CSB_PORT に空いている番号を指定してください。');
  process.exit(1);
}

// ── 起動用ショートカット(.lnk)を初回起動時に作る ───────────────
// .cmd 自体には Windows の仕様でアイコンを設定できないため、.lnk を別に用意する。
// 対象を絶対パスで持つので、置き場所が変わっても壊れないよう起動のたびに
// 「無ければ今のパスで作る」。失敗しても起動は続ける。
function ensureShortcut() {
  if (process.platform !== 'win32') return;
  try {
    const launcher = path.join(APP_DIR, '..', 'claude-session-boardを起動.cmd');
    if (!fs.existsSync(launcher)) return; // 配布物の形ではない(ソースから起動)
    const parent = path.join(APP_DIR, '..');
    const lnk = path.join(parent, 'claude-session-board.lnk');
    if (fs.existsSync(lnk)) return;
    const ico = path.join(PUBLIC_DIR, 'icons', 'app.ico');
    if (!fs.existsSync(ico)) return;
    const q = (s) => "'" + s.replace(/'/g, "''") + "'";
    const ps = [
      '$w = New-Object -ComObject WScript.Shell;',
      '$s = $w.CreateShortcut(' + q(lnk) + ');',
      '$s.TargetPath = ' + q(launcher) + ';',
      '$s.WorkingDirectory = ' + q(parent) + ';',
      '$s.IconLocation = ' + q(ico) + ';',
      '$s.Description = ' + q('Claude Session Board を起動します') + ';',
      '$s.Save()',
    ].join(' ');
    require('child_process').execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps],
      { windowsHide: true },
      (err) => {
        if (err) console.log('[info] ショートカットは作れませんでした(起動には影響しません)');
        else console.log('[info] ショートカット「claude-session-board」を作りました');
      });
  } catch (_) { /* 起動を妨げない */ }
}

// ── CbC Tools への heartbeat（任意・失敗は無視）──────────────────
// CbCが動いていれば「生きている」ことを2秒おきに知らせる。
// 動いていなければ送信は黙って失敗させる(このツール自体はCbC無しでも単体で動く)。
// 仕様: gh/apps/cbc-tools/CONNECT.md の heartbeat 契約に合わせている。
// ★宛先ポートは決め打ちにしない: CbCから起動された場合はCBC_PORTが環境変数で渡される
//   (既定ポート47821が他アプリと衝突していれば、CbC自身が隣の空き番号へ移るため)。
//   このツールを手動起動した場合はCBC_PORTが無いので既定の47821を使う。
function sendCbcHeartbeat(port) {
  try {
    const cbcPort = Number(process.env.CBC_PORT) || 47821;
    const payload = JSON.stringify({ level: 'ok', detail: `http://${HOST}:${port}/`, pid: process.pid });
    const req = http.request({
      host: '127.0.0.1', port: cbcPort, path: '/api/state/claude-session-board',
      method: 'POST', timeout: 1000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => { res.resume(); });
    req.on('error', () => {}); // CbC が動いていない/無い環境では黙って捨てる
    req.on('timeout', () => req.destroy());
    req.end(payload);
  } catch (_) { /* 起動を妨げない */ }
}

// 直接起動されたときだけサーバを立てる（require時はテスト用に関数だけ使える）
if (require.main === module) {
  ensureShortcut();
  listenWithFallback(PORT).then(actualPort => {
    if (actualPort === null) return; // 既に動いていたので開いて終わった
    PORT = actualPort; // sameOrigin()判定等がこの後の実ポートを見られるようにする
    const url = `http://${HOST}:${actualPort}/`;
    console.log('');
    console.log('  Claude Session Board を起動しました。');
    console.log('  ブラウザが自動で開きます。この画面は閉じないでください。');
    console.log('');
    console.log(`  画面      : ${url}`);
    console.log(`  データ    : ${DATA_DIR}`);
    console.log('');
    console.log('  止めるときは、この画面で Ctrl+C。');
    console.log('');
    // ★機械が読む目印。自動テストはこの行で「起動した」と判断する。
    console.log(`[ready] ${url}`);

    // 実際に待受けたポートを外へ知らせる。
    // ★起動役（start-board.vbs）がこれを読んでブラウザを開く。
    //   4788 が埋まっていて隣へ移った場合、ここに書かないと
    //   起動役が別の番号を開いてしまう（CbC で同じ穴を踏んだ）。
    try {
      fs.writeFileSync(path.join(__dirname, 'port.txt'), String(actualPort), 'utf8');
    } catch (_) { /* 書けなくても本体は動く */ }
    console.log(`[info] home=${HOME} dataDir=${DATA_DIR} port=${actualPort}`);
    openBrowser(url);
    if (!process.env.CSB_NO_HEARTBEAT) {
      sendCbcHeartbeat(actualPort);
      setInterval(() => sendCbcHeartbeat(actualPort), 2000).unref();
    }
  });
}

module.exports = { buildWtArgs, buildTabArgs, dryRunString, buildPreview, deepExtract, scanSessions, loadBoard, probeSelf, listenWithFallback };
