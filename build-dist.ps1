param(
    [switch]$NoZip,
    [switch]$NoNode,
    [string]$NodeVersion = '22.16.0'
)

# 配布物を組む(yarubeki-editor/build-dist.ps1 を土台に、このアプリ向けに調整)。
#
# ここが守るべきこと:
#  1. 受け取った人が「展開してダブルクリックするだけ」で動くこと。
#     → Node.js を同梱する(このアプリは外部npm依存が無いので npm install は不要)。
#  2. インターネットに接続していなくても動くこと。
#     → 出来上がった物に外部への参照が残っていないかを、毎回機械的に確かめる。
#  3. 利用者の実データ(board.json 等)・本番PC固有の絶対パスを絶対に混ぜないこと。
#     → 下の「中止ゲート」で機械的に確認し、1つでも引っかかれば例外を投げて止まる。

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$distName = 'claude-session-board'
$distDir  = Join-Path $PSScriptRoot "dist\$distName"
$zipFile  = Join-Path $PSScriptRoot "dist\$distName.zip"
$cacheDir = Join-Path $PSScriptRoot "dist\.cache"
$launcherName = 'claude-session-boardを起動.cmd'

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " claude-session-board dist build" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

if (Test-Path $distDir) {
    Write-Host "Cleaning previous build..."
    Remove-Item $distDir -Recurse -Force
}
if (Test-Path $zipFile) {
    Remove-Item $zipFile -Force
}

Write-Host "Creating folders..."
New-Item -ItemType Directory -Path $distDir -Force | Out-Null
$appDir = Join-Path $distDir 'app'
New-Item -ItemType Directory -Path $appDir -Force | Out-Null

Write-Host "Copying core files..."
# install-admin-task.ps1 / start-board.vbs / run-hidden.vbs は本番PC固有の
# 手元の運用専用で、置き場所を決め打ちしたファイルなので、
# 配布物には入れない(yarubeki-editorがSPEC.md/migrate.jsを外したのと同じ考え方)。
# REQUIREMENTS.md / BUILD-REPORT.md / test-checks.js も開発者向けなので入れない。
foreach ($f in @('server.js')) {
    $src = Join-Path $PSScriptRoot $f
    if (Test-Path $src) { Copy-Item $src $appDir }
}
Copy-Item (Join-Path $PSScriptRoot 'start-board.cmd') (Join-Path $distDir $launcherName)

Write-Host "Copying frontend..."
Copy-Item (Join-Path $PSScriptRoot 'public') $appDir -Recurse
Get-ChildItem (Join-Path $appDir 'public') -Recurse -File -Include '*.bak', '*.bak-*', '*.orig' |
    Remove-Item -Force -ErrorAction SilentlyContinue

# --- Node.js 本体を同梱する ---
# このアプリは外部npm依存が無い(コード冒頭のコメントどおりNode標準モジュールのみ)ので、
# npm/npx や node_modules は要らない。node.exe だけを入れる。
if (-not $NoNode) {
    $nodeZipName = "node-v$NodeVersion-win-x64.zip"
    $nodeUrl = "https://nodejs.org/dist/v$NodeVersion/$nodeZipName"
    $cachedZip = Join-Path $cacheDir $nodeZipName

    if (-not (Test-Path $cacheDir)) {
        New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
    }

    if (Test-Path $cachedZip) {
        Write-Host "Node.js v$NodeVersion (cached)"
    } else {
        Write-Host "Downloading Node.js v$NodeVersion ..."
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $wc = New-Object System.Net.WebClient
        $wc.DownloadFile($nodeUrl, $cachedZip)
        $wc.Dispose()
        Write-Host "  Downloaded: $nodeZipName"
    }

    Write-Host "Extracting Node.js..."
    $tmpExtract = Join-Path $cacheDir "node-extract"
    if (Test-Path $tmpExtract) { Remove-Item $tmpExtract -Recurse -Force }
    Expand-Archive -Path $cachedZip -DestinationPath $tmpExtract -Force

    $extractedDir = Get-ChildItem $tmpExtract -Directory | Select-Object -First 1
    $nodeDistDir = Join-Path $appDir "node"
    New-Item -ItemType Directory -Path $nodeDistDir -Force | Out-Null
    Copy-Item (Join-Path $extractedDir.FullName 'node.exe') $nodeDistDir

    Remove-Item $tmpExtract -Recurse -Force
    Write-Host "  Bundled node.exe to node/" -ForegroundColor Green
} else {
    Write-Host "Skipping Node.js bundle (--NoNode)"
}

# --- 中止ゲート1: 利用者の実データが混ざっていないか ---
Write-Host "Checking for leaked personal data..."
$leaked = @()
foreach ($n in @('board.json', 'scan-cache.json', 'status-state.json')) {
    if (Test-Path (Join-Path $appDir $n)) { $leaked += $n }
    if (Test-Path (Join-Path $appDir "public\$n")) { $leaked += "public\$n" }
}
$leakedFiles = Get-ChildItem $distDir -Recurse -File -Include 'board.json', 'scan-cache.json', 'status-state.json', '*.corrupt-*.bak' -ErrorAction SilentlyContinue
if ($leakedFiles) { $leaked += ($leakedFiles | ForEach-Object { $_.FullName.Substring($distDir.Length + 1) }) }
if ($leaked.Count -gt 0) {
    $leaked | Select-Object -Unique | ForEach-Object { Write-Host ("  " + $_) -ForegroundColor Red }
    throw "配布物に利用者の実データが混ざっています。配布を中止します。"
}
Write-Host "  No personal data (board.json / scan-cache.json / status-state.json)" -ForegroundColor Green

# --- 中止ゲート2: 本番PC固有の絶対パスが混ざっていないか ---
Write-Host "Checking for hardcoded absolute paths (C:\Users\<name>)..."
$pathOffenders = @()
foreach ($f in (Get-ChildItem $distDir -Recurse -File -Include '*.js', '*.cmd', '*.html', '*.json', '*.txt', '*.vbs', '*.ps1', '*.md')) {
    $text = Get-Content $f.FullName -Raw -ErrorAction SilentlyContinue
    if ($text -and $text -match '(?i)[A-Z]:\\Users\\(?!Public|Default|All Users|name|user|username|you|example)[A-Za-z0-9_.-]+') {
        $pathOffenders += $f.FullName.Substring($distDir.Length + 1)
    }
}
if ($pathOffenders.Count -gt 0) {
    $pathOffenders | Select-Object -Unique | ForEach-Object { Write-Host ("  " + $_) -ForegroundColor Red }
    throw "配布物に本番PC固有の絶対パスが混ざっています。配布を中止します。"
}
Write-Host "  No hardcoded user paths" -ForegroundColor Green

# --- 中止ゲート3: 起動スクリプトが cmd.exe に安全に読めるか ---
Write-Host "Checking launcher encoding..."
$checker = Join-Path $PSScriptRoot 'tools\check-cmd-encoding.js'
$bundledNode = Join-Path (Join-Path $appDir 'node') 'node.exe'
$nodeForCheck = if (Test-Path $bundledNode) { $bundledNode } else { 'node' }
& $nodeForCheck $checker (Join-Path $distDir $launcherName) | Out-Host
if ($LASTEXITCODE -ne 0) { throw "起動用.cmdがcmd.exeに安全に読めません。上の指摘を直してから配布してください。" }
Write-Host "  Launcher encoding OK" -ForegroundColor Green

# --- 中止ゲート4: 外部URL(CDN等)への参照が無いか ---
Write-Host "Checking for external references..."
$offenders = @()
foreach ($f in (Get-ChildItem (Join-Path $appDir 'public') -Recurse -File -Include '*.html', '*.js', '*.css')) {
    $text = Get-Content $f.FullName -Raw -ErrorAction SilentlyContinue
    if (-not $text) { continue }
    foreach ($m in [regex]::Matches($text, '(?i)(src|href)\s*=\s*"(https?:)')) {
        $offenders += ($f.Name + ': ' + $m.Value)
    }
    foreach ($m in [regex]::Matches($text, "(?i)(fetch|import)\s*\(\s*['\`"]https?:")) {
        $offenders += ($f.Name + ': ' + $m.Value)
    }
}
if ($offenders.Count -gt 0) {
    $offenders | Select-Object -Unique | ForEach-Object { Write-Host ("  " + $_) -ForegroundColor Red }
    throw "配布物が外部を参照しています。オフラインで動かないので中止します。"
}
Write-Host "  No external src/href/fetch in shipped files" -ForegroundColor Green

# --- アイコンが揃っているか ---
$iconDir = Join-Path $appDir 'public\icons'
$needIcons = @('app-a.svg', 'app-b.svg', 'app-c.svg', 'app.ico', 'app-16.png', 'app-32.png', 'app-48.png', 'app-128.png', 'app-256.png')
if (-not (Test-Path (Join-Path (Join-Path $appDir 'public') 'favicon.ico'))) {
    throw "public/favicon.ico がありません。node tools/make-icons-all.js を実行してください。"
}
$missIcons = @()
foreach ($n in $needIcons) { if (-not (Test-Path (Join-Path $iconDir $n))) { $missIcons += $n } }
if ($missIcons.Count -gt 0) {
    $missIcons | ForEach-Object { Write-Host ("  " + $_) -ForegroundColor Red }
    throw "アイコンが足りません。node tools/make-icons-all.js を実行してください。"
}
Write-Host "  Icons OK (3案 svg + 既定ico + 5 png + favicon)" -ForegroundColor Green

# --- 最上位に置くもの ---
Write-Host "Creating top-level files..."
$hajimeni = @(
    "はじめにお読みください"
    "======================"
    ""
    "Claude Session Board へようこそ。"
    "Claude Code の過去のセッションを、ピン留め・プレビュー付きの盤面で見て、"
    "ワンクリックで元のセッションを開き直すためのツールです。"
    ""
    ""
    "1. 使いはじめる"
    "---------------"
    "このフォルダの"
    ""
    "    $launcherName"
    ""
    "をダブルクリックしてください。黒い画面が出たあと、ブラウザが開きます。"
    "その黒い画面は、使っている間は閉じないでください。"
    ""
    "  ・何かを入れる必要はありません(Node.js は同梱しています)"
    "  ・インターネットに接続していなくても動きます"
    "  ・どこかへ送信もしません。見ているのはこのPCの中の Claude Code のログだけです"
    ""
    "初回起動のあと、このフォルダに"
    ""
    "    claude-session-board.lnk"
    ""
    "というショートカットができます(アイコン付き)。"
    "デスクトップやタスクバーに置きたいときは、これをドラッグしてください。"
    ""
    ""
    "2. Windows の警告が出たとき"
    "---------------------------"
    "このアプリには署名を付けていないため、初回にこう出ることがあります。"
    ""
    "  「WindowsによってPCが保護されました」"
    "      → [詳細情報] を押す → [実行] を押す"
    ""
    "  zip を右クリック →[プロパティ]に「セキュリティ: ブロックの解除」があるときは、"
    "  先にそれにチェックを入れてから展開すると、警告が出にくくなります。"
    ""
    ""
    "3. 見ているデータはどこにあるか"
    "-------------------------------"
    "このアプリ自身は何も収集しません。読むのは"
    ""
    "  %USERPROFILE%\.claude\projects\   Claude Code のセッション記録(既存のもの)"
    ""
    "だけです。ピン留め・設定は app フォルダの中に board.json として保存されます"
    "(このzipには入っていません。初回起動時に空の状態で作られます)。"
    ""
    ""
    "4. 困ったとき"
    "-------------"
    "・ポート 4788 を使います。埋まっていたら自動で次の番号を探すので、"
    "  そのまま使えます(黒い画面にどの番号を使ったかが出ます)。"
    "・二重に起動しても大丈夫です。すでに動いている画面が開きます。"
)
[System.IO.File]::WriteAllText(
    (Join-Path $distDir 'はじめにお読みください.txt'),
    ($hajimeni -join "`r`n"),
    (New-Object System.Text.UTF8Encoding $true))
Write-Host "  はじめにお読みください.txt" -ForegroundColor Green

# --- 最上位に余計なものが出ていないか ---
$allowedTop = @('app', $launcherName, 'はじめにお読みください.txt', 'claude-session-board.lnk')
$extra = Get-ChildItem $distDir | Where-Object { $allowedTop -notcontains $_.Name }
if ($extra) {
    $extra | ForEach-Object { Write-Host ("  " + $_.Name) -ForegroundColor Red }
    throw "最上位に予定外のものがあります。押すべきファイルが埋もれるので中止します。"
}
Write-Host "  Top level is clean" -ForegroundColor Green

$files = Get-ChildItem $distDir -Recurse -File
$totalSize = ($files | Measure-Object -Property Length -Sum).Sum
$sizeMB = [math]::Round($totalSize / 1MB, 1)

Write-Host ""
Write-Host "Package: $($files.Count) files ($sizeMB MB)" -ForegroundColor Green

if (-not $NoZip) {
    Write-Host "Creating ZIP..."
    Compress-Archive -Path $distDir -DestinationPath $zipFile -Force
    $zipSize = [math]::Round((Get-Item $zipFile).Length / 1MB, 1)
    Write-Host "  $zipFile ($zipSize MB)" -ForegroundColor Green
}

Write-Host ""
Write-Host "Done." -ForegroundColor Cyan
Write-Host ""
