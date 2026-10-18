<#
.SYNOPSIS
    在「个人 QQ」和「NapCat 机器人 QQ」之间切换同一份 QQ 安装。

.DESCRIPTION
    NapCat 是通过改 QQ 的启动入口（resources\app\package.json 的 main 字段）注入的，
    所以同一份安装不能同时当个人 QQ 和机器人用。这个脚本做三件事：

      1. 停掉正在跑的 QQ / NapCat
      2. 把 package.json 的 main 改成目标模式（官方入口 / NapCat 入口）
      3. 启动对应的程序

    它只改 main 一个字段，其余内容原样保留，写完会立刻读回来校验；
    第一次运行会把「原始 main」记进 qq-switch.state.json，之后来回切都靠它。

.PARAMETER Mode
    bot       → 切到机器人（NapCat）
    personal  → 切回个人 QQ

.PARAMETER QQDir
    QQ 安装目录（有 QQ.exe 的那一层）。默认取本脚本的上一级目录，
    也就是把脚本放进 QQ 安装目录后直接双击即可。

.PARAMETER Account
    机器人 QQ 号。bot 模式下如果没有传，会提示输入一次，之后记在状态文件里。

.PARAMETER DryRun
    只打印将要做什么，不真的杀进程 / 改文件 / 启动。

.EXAMPLE
    .\switch-qq.ps1 -Mode personal
    .\switch-qq.ps1 -Mode bot -Account 1973631352
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('bot', 'personal')]
    [string]$Mode,

    [string]$QQDir = '',

    [string]$Account = '',

    [string]$NapCatEntry = './napcat/napcat.mjs',

    [switch]$DryRun,

    [switch]$SkipProcesses,

    [switch]$SkipStart
)

$ErrorActionPreference = 'Stop'

# 没传 -QQDir 时：默认就是脚本所在目录（脚本与 QQ.exe 放在一起）
if ([string]::IsNullOrWhiteSpace($QQDir)) {
    $scriptDir = if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
    $QQDir = $scriptDir
}

$stateFile = Join-Path $QQDir 'qq-switch.state.json'
$logFile = Join-Path $QQDir 'qq-switch.log'

function Log([string]$message) {
    $line = "$(Get-Date -Format 'HH:mm:ss')  $message"
    Write-Host $line
    try { Add-Content -Path $logFile -Value $line -Encoding UTF8 } catch { }
}

function Fail([string]$message) {
    Write-Host "错误：$message" -ForegroundColor Red
    try { Add-Content -Path $logFile -Value "$(Get-Date -Format 'HH:mm:ss')  错误：$message" -Encoding UTF8 } catch { }
    exit 1
}

# ---------- 1. 定位 package.json ----------
if (-not (Test-Path (Join-Path $QQDir 'QQ.exe'))) {
    Fail "在 $QQDir 下没找到 QQ.exe。把本脚本放到 QQ 安装目录（与 QQ.exe 同级），或用 -QQDir 指定。"
}

$candidates = @()
$versionsDir = Join-Path $QQDir 'versions'
if (Test-Path $versionsDir) {
    $candidates = Get-ChildItem $versionsDir -Directory |
        Where-Object { Test-Path (Join-Path $_.FullName 'resources\app\package.json') } |
        Sort-Object Name -Descending
}
if ($candidates.Count -eq 0) {
    # 老布局：package.json 直接放在 resources\app 下
    $flat = Join-Path $QQDir 'resources\app\package.json'
    if (Test-Path $flat) { $candidates = @(Get-Item (Join-Path $QQDir 'resources\app')) }
}
if ($candidates.Count -eq 0) { Fail '没找到 resources\app\package.json，这不像 QQNT 的目录结构。' }

$appDir = if ($candidates[0].FullName -like '*\versions\*') { Join-Path $candidates[0].FullName 'resources\app' } else { $candidates[0].FullName }
$pkgPath = Join-Path $appDir 'package.json'
Log "QQ 目录：$QQDir"
Log "启动配置：$pkgPath"

$package = Get-Content $pkgPath -Raw | ConvertFrom-Json
$currentMain = [string]$package.main
if ([string]::IsNullOrWhiteSpace($currentMain)) { Fail 'package.json 里没有 main 字段，不敢乱改。' }
Log "当前 main：$currentMain"

# ---------- 2. 读/写状态 ----------
$state = $null
if (Test-Path $stateFile) {
    try { $state = Get-Content $stateFile -Raw | ConvertFrom-Json } catch { $state = $null }
}
if ($null -eq $state) {
    $state = [pscustomobject]@{ personalMain = ''; botMain = $NapCatEntry; account = $Account }
}
if (-not $state.PSObject.Properties['personalMain']) { $state | Add-Member -NotePropertyName personalMain -NotePropertyValue '' }
if (-not $state.PSObject.Properties['botMain']) { $state | Add-Member -NotePropertyName botMain -NotePropertyValue $NapCatEntry }
if (-not $state.PSObject.Properties['account']) { $state | Add-Member -NotePropertyName account -NotePropertyValue '' }

if (-not $currentMain.Contains('napcat')) {
    $state.personalMain = $currentMain
} elseif ([string]::IsNullOrWhiteSpace($state.personalMain)) {
    $state.personalMain = './application.asar/app_launcher/index.js'
    Log '提示：没有记录过原始入口，暂用 ./application.asar/app_launcher/index.js'
}

if ($Mode -eq 'bot') {
    if ([string]::IsNullOrWhiteSpace($state.account)) {
        if ([string]::IsNullOrWhiteSpace($Account)) {
            $Account = Read-Host '请输入机器人 QQ 号'
        }
        $state.account = $Account.Trim()
    }
    $targetMain = $state.botMain
    $napcatFile = Join-Path $appDir 'napcat\napcat.mjs'
    if (-not (Test-Path $napcatFile)) {
        Fail "没找到 $napcatFile —— 这份 QQ 装过 NapCat 吗？先用 NapCat 的安装器/启动器装一次。"
    }
    if ([string]::IsNullOrWhiteSpace($state.account)) { Fail '没拿到机器人 QQ 号。' }
} else {
    if ([string]::IsNullOrWhiteSpace($state.personalMain)) { Fail '不知道官方入口是什么，无法切回。' }
    $targetMain = $state.personalMain
}

Log "目标 main：$targetMain（模式：$Mode）"

# ---------- 3. 停进程 ----------
if ($DryRun -or $SkipProcesses) {
    Log '[跳过] 不停进程'
} else {
    $running = Get-Process -Name 'NapCatWinBootMain', 'QQ' -ErrorAction SilentlyContinue
    if ($running) {
        Log "停止进程：$((($running | Select-Object -ExpandProperty ProcessName) | Sort-Object -Unique) -join ', ')"
        $running | Stop-Process -Force -ErrorAction SilentlyContinue
    } else {
        Log '没有正在运行的 QQ / NapCat'
    }
    Start-Sleep -Seconds 4
    if (Get-Process -Name 'QQ' -ErrorAction SilentlyContinue) { Fail 'QQ 没有完全退出，请稍后再试（或手动在任务管理器结束 QQ.exe）。' }
}

# ---------- 4. 用备份整体覆盖（必须字节级一致，QQ 会校验 package.json 完整性） ----------
$personalBak = Join-Path $QQDir 'package.personal.bak'
$botBak = Join-Path $QQDir 'package.bot.bak'

# 首次运行：缺哪个备份就按当前文件 / 文本替换生成
if (-not (Test-Path $personalBak)) {
    if ($currentMain.Contains('napcat')) {
        Fail "缺少 $personalBak（原始 package.json 备份）。请先把 QQ 恢复成官方入口再跑一次，或手动放一份原始 package.json 为 package.personal.bak。"
    }
    Copy-Item $pkgPath $personalBak -Force
    Log "已保存原始 package.json → package.personal.bak"
}
if (-not (Test-Path $botBak)) {
    # 只替换 main 的值，其余字节原样保留
    $text = [System.IO.File]::ReadAllText($personalBak)
    $patched = [regex]::Replace($text, '("main"\s*:\s*")[^"]*(")', { param($m) $m.Groups[1].Value + $state.botMain + $m.Groups[2].Value })
    [System.IO.File]::WriteAllText($botBak, $patched, (New-Object System.Text.UTF8Encoding($false)))
    Log "已生成 package.bot.bak（main = $($state.botMain)）"
}

$sourceBak = if ($Mode -eq 'bot') { $botBak } else { $personalBak }
if (-not (Test-Path $sourceBak)) { Fail "找不到备份文件 $sourceBak" }

$currentBytes = [System.IO.File]::ReadAllBytes($pkgPath)
$sourceBytes = [System.IO.File]::ReadAllBytes($sourceBak)

if ($DryRun) {
    Log "[DryRun] 将用 $([System.IO.Path]::GetFileName($sourceBak))（$($sourceBytes.Length) 字节）覆盖 package.json（当前 $($currentBytes.Length) 字节）"
} else {
    Copy-Item $sourceBak $pkgPath -Force
    $check = Get-Content $pkgPath -Raw | ConvertFrom-Json
    $head = [System.IO.File]::ReadAllBytes($pkgPath)[0]
    Log "写入后 main：$($check.main)（$((Get-Item $pkgPath).Length) 字节）"
    if ($head -eq 239) { Fail '写入的 package.json 带了 BOM，请手动检查。' }
    if ([string]$check.main -ne $targetMain) { Fail '写入后校验失败：main 没变成目标值。' }
}

# ---------- 5. 保存状态 ----------
if (-not $DryRun) {
    $state | ConvertTo-Json -Depth 8 | Set-Content -Path $stateFile -Encoding UTF8
}

# ---------- 6. 启动 ----------
if ($DryRun -or $SkipStart) {
    Log '[跳过] 不启动'
    return
}

try {
    if ($Mode -eq 'bot') {
        $exe = Join-Path $QQDir 'NapCatWinBootMain.exe'
        if (-not (Test-Path $exe)) { Fail "没找到 $exe（NapCat 的启动器）。" }
        Log "启动 NapCat（账号 $($state.account)）"
        Start-Process -FilePath $exe -ArgumentList $state.account -WorkingDirectory $QQDir
        Start-Sleep -Seconds 10
        if (-not (Get-Process -Name 'QQ' -ErrorAction SilentlyContinue)) {
            Fail 'QQ 没有启动。看 NapCat 窗口：可能要重新扫码，或 3000/3001 端口被占用。'
        }
        Log '完成：机器人已启动（NapCat 窗口不要关）'
    } else {
        Log '启动个人 QQ'
        Start-Process -FilePath (Join-Path $QQDir 'QQ.exe') -WorkingDirectory $QQDir
        Start-Sleep -Seconds 4
        if (-not (Get-Process -Name 'QQ' -ErrorAction SilentlyContinue)) { Fail 'QQ 没有启动起来。' }
        Log '完成：个人 QQ 已启动，请登录'
    }
} catch {
    Fail $_.Exception.Message
}

Write-Host ''
Write-Host ('切换成功：' + $(if ($Mode -eq 'bot') { '机器人模式' } else { '个人模式' })) -ForegroundColor Green
Write-Host "日志：$logFile"
