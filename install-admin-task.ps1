# =============================================================
#  install-admin-task.ps1  —  セッションボードを「常に管理者」で動かす
# -------------------------------------------------------------
#  ★ このスクリプトを1回だけ管理者として実行してください。
#     以後 start-board.vbs から UAC を出さずに管理者権限で起動できます。
#
#  仕組み: 「最高の特権で実行する」タスクを登録し、起動はタスク経由にする。
#          ショートカットの『管理者として実行』だと毎回 UAC が出るが、
#          タスクスケジューラ経由なら出ない。
#
#  ・ログオン時に自動起動（-NoAutoStart で無効化できる）
#  ・「ユーザーがログオンしているときのみ実行」＝ wt のタブが
#    ちゃんとデスクトップに出る（session 0 だと画面に出ないため）
#
#  ⚠ 注意: ボードが管理者で動くと、そこから開く claude のタブも
#     管理者になります。保護されたフォルダを編集できる反面、
#     そのセッションが作るファイルは昇格状態で作られます。
#
#  ★★ 普段は入れなくてよい（2026-08-15に過去ログを実地調査した結論）★★
#
#   「Claude が permission で詰まる」の中身を全セッションのログで数えたところ:
#
#     1) Claude Code 自身の許可プロンプト（ツール実行の allow/deny）
#        …… 一番よく詰まるのはこれ。**管理者権限では一切変わらない**。
#           対処は settings.json の許可リスト（/fewer-permission-prompts）。
#     2) UnauthorizedAccessException 92件
#        …… 実体は「Cannot overwrite variable PID（PowerShellの予約変数に代入）」
#           というスクリプトのバグ。**権限とは無関係**。
#     3) 本当に昇格が要ったもの
#        …… ほぼ全部が「タスクスケジューラへの登録」。つまり
#           セットアップ時の一度きりの操作であって、日常の作業ではない。
#
#   → 常時昇格は「①②に効かず、③のためだけに全セッションを管理者にする」ことになり
#     割に合わない。③が出た時だけ、その操作を昇格して実行するのが正解。
#     （このスクリプト自体がその一例。必要な時だけ管理者で1回叩く）
#
#  解除:  .\install-admin-task.ps1 -Uninstall
# =============================================================
param(
    [switch]$Uninstall,
    [switch]$NoAutoStart
)

$ErrorActionPreference = 'Stop'
$TaskName = 'ClaudeSessionBoard'
# このファイルが置かれている場所を app のフォルダとする。
# ★利用者名つきの絶対パスを書かない（他の人のPCで動かなくなるし、
#   公開リポジトリだと持ち主の名前が漏れる）。
$AppDir   = $PSScriptRoot
$Launcher = Join-Path $AppDir 'run-hidden.vbs'

# --- 管理者チェック ---
$pr = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host ''
    Write-Host '  管理者として実行してください。' -ForegroundColor Red
    Write-Host '  やり方: このファイルを右クリック →「PowerShell で実行」ではなく、'
    Write-Host '          スタートメニューで PowerShell を右クリック →「管理者として実行」'
    Write-Host '          そのあと次を貼り付け:'
    Write-Host ''
    Write-Host "    cd '$AppDir'; .\install-admin-task.ps1" -ForegroundColor Yellow
    Write-Host ''
    exit 1
}

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "  タスク $TaskName を削除しました。" -ForegroundColor Green
        Write-Host '  start-board.vbs は通常権限での起動に自動で戻ります。'
    } else {
        Write-Host "  タスク $TaskName はありません。"
    }
    exit 0
}

if (-not (Test-Path $Launcher)) { throw "起動用スクリプトが見つかりません: $Launcher" }

# 既にあれば作り直す（設定変更を確実に反映）
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction -Execute 'wscript.exe' `
            -Argument ('"' + $Launcher + '"') -WorkingDirectory $AppDir

# 「ログオンしているときのみ」= Interactive。これでないと wt が画面に出ない。
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
               -LogonType Interactive -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) `
              -MultipleInstances IgnoreNew

$triggers = @()
if (-not $NoAutoStart) {
    $triggers += New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
}

$reg = @{
    TaskName    = $TaskName
    Action      = $action
    Principal   = $principal
    Settings    = $settings
    Description = 'Claude Session Board を管理者権限で起動する（起動は start-board.vbs から）'
}
if ($triggers.Count) { $reg['Trigger'] = $triggers }

Register-ScheduledTask @reg | Out-Null

Write-Host ''
Write-Host "  ✔ タスク $TaskName を登録しました（最高の特権）" -ForegroundColor Green
if ($NoAutoStart) { Write-Host '    自動起動: なし（start-board.vbs を実行した時だけ）' }
else              { Write-Host '    自動起動: ログオン時' }
Write-Host ''
Write-Host '  これ以降 start-board.vbs は UAC を出さずに管理者で起動します。'
Write-Host '  今すぐ起動するなら:' -NoNewline
Write-Host "  schtasks /run /tn $TaskName" -ForegroundColor Yellow
Write-Host ''
Write-Host '  ⚠ ボードから開く claude のタブも管理者になります。' -ForegroundColor DarkYellow
Write-Host '     元に戻す場合:  .\install-admin-task.ps1 -Uninstall'
Write-Host ''
