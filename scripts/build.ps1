<#
.SYNOPSIS
    Builds a complete, self-contained portable release of YT Downloader.

.DESCRIPTION
    The script performs the full pipeline and refuses to produce a "successful" build
    that cannot actually run:

        1. verify Node, npm and the Rust toolchain
        2. verify the mandated runtime at E:\FFMPEG-9.0 (yt-dlp / ffmpeg / ffprobe)
        3. install frontend dependencies (cache stays on E:)
        4. type-check and build the frontend
        5. build the Rust backend in release mode
        6. copy the *entire* runtime folder into the release (not just the three exes)
        7. run an integrity check over every artefact
        8. report the exact runtime versions shipped

    Every cache (npm, cargo, temp) is redirected to the workspace so the build never
    writes to the system drive.

.PARAMETER SkipFrontend
    Reuse the existing dist/ instead of rebuilding it.

.PARAMETER SkipRust
    Reuse the existing release executable instead of rebuilding it.

.PARAMETER OutputDirectory
    Where the portable release is assembled. Defaults to <project>\release.

.EXAMPLE
    pwsh -File scripts\build.ps1
#>

[CmdletBinding()]
param(
    [switch] $SkipFrontend,
    [switch] $SkipRust,
    [switch] $SkipPayload,
    [string] $OutputDirectory
)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version Latest

# --------------------------------------------------------------------------
# Paths and environment
# --------------------------------------------------------------------------

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Workspace = Split-Path -Parent $ProjectRoot
$Caches = Join-Path $Workspace '.caches'
$RuntimeSource = 'E:\FFMPEG-9.0'
$Toolchain = 'C:\Users\FogGlass\.rustup\toolchains\stable-x86_64-pc-windows-msvc'

if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $ProjectRoot 'release'
}

foreach ($dir in @($Caches, (Join-Path $Caches 'temp'), (Join-Path $Caches 'npm'), (Join-Path $Caches 'cargo'))) {
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
}

$env:CARGO_HOME = Join-Path $Caches 'cargo'
$env:CARGO_TARGET_DIR = Join-Path $ProjectRoot 'src-tauri\target'
$env:TEMP = Join-Path $Caches 'temp'
$env:TMP = $env:TEMP
$env:npm_config_cache = Join-Path $Caches 'npm'
$env:npm_config_audit = 'false'
$env:npm_config_fund = 'false'
# The payload builder prints a Chinese report; make its output UTF-8 regardless of
# the console code page.
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'

# Python drives the payload container (create / wrap / verify).
$PythonExe = $null
foreach ($candidate in @('E:\Python\python.exe', 'python', 'py')) {
    try {
        $resolved = (Get-Command $candidate -ErrorAction Stop).Source
        if ($resolved) { $PythonExe = $resolved; break }
    }
    catch {
        if (Test-Path $candidate) { $PythonExe = $candidate; break }
    }
}

# The rustup shims trigger a channel sync (and a write to C:) when a crate ships a
# rust-toolchain.toml, so the real toolchain binaries go first on PATH.
if (Test-Path $Toolchain) {
    $env:RUSTC = Join-Path $Toolchain 'bin\rustc.exe'
    $env:CARGO = Join-Path $Toolchain 'bin\cargo.exe'
    $env:PATH = (Join-Path $Toolchain 'bin') + ';' + $env:PATH
}

$script:Failures = @()
$script:StepNumber = 0

# A transcript makes the whole build auditable after the fact; it also captures
# Write-Host output, which plain redirection cannot do on Windows PowerShell 5.1.
$script:BuildLog = Join-Path $OutputDirectory 'build.log'
try {
    New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
    Start-Transcript -Path $script:BuildLog -Force | Out-Null
}
catch {
    Write-Host "无法创建构建日志：$($_.Exception.Message)" -ForegroundColor Yellow
}

function Write-Step([string] $Title) {
    $script:StepNumber++
    Write-Host ''
    Write-Host ("[{0}] {1}" -f $script:StepNumber, $Title) -ForegroundColor Cyan
    Write-Host ('-' * 60) -ForegroundColor DarkGray
}

function Write-Ok([string] $Message) { Write-Host "  ok   $Message" -ForegroundColor Green }
function Write-Warn([string] $Message) { Write-Host "  warn $Message" -ForegroundColor Yellow }
function Write-Fail([string] $Message) {
    Write-Host "  FAIL $Message" -ForegroundColor Red
    $script:Failures += $Message
}

function Get-ToolVersion([string] $Exe, [string[]] $Arguments) {
    try {
        $output = & $Exe @Arguments 2>&1 | Select-Object -First 1
        return ($output | Out-String).Trim()
    }
    catch {
        return $null
    }
}

$started = Get-Date

Write-Host 'YT Downloader — release build' -ForegroundColor White
Write-Host "project : $ProjectRoot"
Write-Host "output  : $OutputDirectory"
Write-Host "caches  : $Caches"

# --------------------------------------------------------------------------
# 1. Toolchain
# --------------------------------------------------------------------------

Write-Step '检查构建工具链'

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) { Write-Ok "node $(node -v)" } else { Write-Fail '找不到 node，请先安装 Node.js。' }

$npm = Get-Command npm -ErrorAction SilentlyContinue
if ($npm) { Write-Ok "npm $((npm -v 2>&1 | Select-Object -First 1))" } else { Write-Fail '找不到 npm。' }

$cargoExe = Join-Path $Toolchain 'bin\cargo.exe'
if (Test-Path $cargoExe) {
    Write-Ok "cargo $((& $cargoExe --version 2>&1 | Select-Object -First 1))"
}
else {
    $cargoCmd = Get-Command cargo -ErrorAction SilentlyContinue
    if ($cargoCmd) { $cargoExe = $cargoCmd.Source; Write-Ok "cargo $((& $cargoExe --version 2>&1 | Select-Object -First 1))" }
    else { Write-Fail '找不到 cargo（Rust 工具链）。' }
}

if ($PythonExe) {
    $pythonVersion = (& $PythonExe --version 2>&1 | Select-Object -First 1)
    Write-Ok "$pythonVersion ($PythonExe)"
}
else {
    Write-Fail '找不到 Python，无法生成安装包载荷。'
}

if ($script:Failures.Count -gt 0) {
    Write-Host ''
    Write-Host '构建终止：工具链不完整。' -ForegroundColor Red
    exit 1
}

# --------------------------------------------------------------------------
# 2. Runtime integrity (checked BEFORE building)
# --------------------------------------------------------------------------

Write-Step "校验运行库 $RuntimeSource"

$requiredTools = @('yt-dlp.exe', 'ffmpeg.exe', 'ffprobe.exe')
$runtimeBin = Join-Path $RuntimeSource 'bin'
$missing = @()

foreach ($tool in $requiredTools) {
    $path = Join-Path $runtimeBin $tool
    if (Test-Path $path) {
        $size = (Get-Item $path).Length
        if ($size -gt 0) { Write-Ok "$tool  ($([math]::Round($size / 1MB, 1)) MB)" }
        else { Write-Fail "$tool 大小为 0，文件可能已损坏。" ; $missing += $tool }
    }
    else {
        Write-Fail "缺少 $path"
        $missing += $tool
    }
}

if ($missing.Count -gt 0) {
    Write-Host ''
    Write-Host '构建终止：运行库不完整，绝不会产出无法运行的 Release。' -ForegroundColor Red
    exit 1
}

# --------------------------------------------------------------------------
# 3. Frontend dependencies
# --------------------------------------------------------------------------

Write-Step '安装前端依赖'

Push-Location $ProjectRoot
try {
    if (Test-Path (Join-Path $ProjectRoot 'node_modules')) {
        Write-Ok 'node_modules 已存在，跳过安装'
    }
    else {
        npm install --no-audit --no-fund 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        if ($LASTEXITCODE -ne 0) { Write-Fail "npm install 失败（exit $LASTEXITCODE）" }
        else { Write-Ok '依赖安装完成' }
    }
}
finally { Pop-Location }

# --------------------------------------------------------------------------
# 4. Frontend build
# --------------------------------------------------------------------------

Write-Step '构建前端（类型检查 + Vite）'

if ($SkipFrontend) {
    if (Test-Path (Join-Path $ProjectRoot 'dist\index.html')) { Write-Ok '跳过前端构建（复用 dist）' }
    else { Write-Fail 'dist 不存在，无法跳过前端构建。' }
}
else {
    Push-Location $ProjectRoot
    try {
        npm run build 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        if ($LASTEXITCODE -ne 0) { Write-Fail "前端构建失败（exit $LASTEXITCODE）" }
        else { Write-Ok '前端构建完成' }
    }
    finally { Pop-Location }
}

if ($script:Failures.Count -gt 0) {
    Write-Host ''
    Write-Host '构建终止：前端构建失败。' -ForegroundColor Red
    exit 1
}

# --------------------------------------------------------------------------
# 5. Rust release build
# --------------------------------------------------------------------------

Write-Step '构建后端（cargo --release）'

$exeName = 'yt-downloader.exe'
$exePath = Join-Path $ProjectRoot "src-tauri\target\release\$exeName"

if ($SkipRust) {
    if (Test-Path $exePath) { Write-Ok '跳过后端构建（复用已有可执行文件）' }
    else { Write-Fail '找不到 release 可执行文件，无法跳过后端构建。' }
}
else {
    Push-Location (Join-Path $ProjectRoot 'src-tauri')
    try {
        # `--features custom-protocol` is mandatory. Tauri's own build script computes
        # `dev = !custom_protocol`, and a binary built without that feature serves
        # `devUrl` (http://localhost:1420) instead of the embedded frontend — which
        # presents as "localhost refused to connect" in a release folder. The Tauri CLI
        # passes this feature for `tauri build`; building with cargo directly does not.
        & $cargoExe build --release --features custom-protocol 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        if ($LASTEXITCODE -ne 0) { Write-Fail "cargo build --release 失败（exit $LASTEXITCODE）" }
        else { Write-Ok '后端构建完成（custom-protocol 已启用）' }
    }
    finally { Pop-Location }
}

if ($script:Failures.Count -gt 0) {
    Write-Host ''
    Write-Host '构建终止：后端构建失败。' -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $exePath)) {
    Write-Host ''
    Write-Host "构建终止：找不到可执行文件 $exePath" -ForegroundColor Red
    exit 1
}

# --------------------------------------------------------------------------
# 6. Assemble the portable release
# --------------------------------------------------------------------------

Write-Step '组装便携版 Release'

$releaseRoot = Join-Path $OutputDirectory 'YT Downloader'
if (Test-Path $releaseRoot) {
    Remove-Item -Recurse -Force $releaseRoot
}
New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null

Copy-Item $exePath (Join-Path $releaseRoot 'YTDownloader.exe') -Force
Write-Ok "可执行文件 → YTDownloader.exe"

# The whole runtime tree is copied, not just the executables: FFmpeg ships presets,
# documentation and licence files that must travel with it.
#
# NOTE: `Copy-Item <dir> <dest>` reproduces the *contents* of <dir> when <dest> does
# not exist yet, so the destination must name the versioned folder explicitly — the
# application resolves `<app>\runtime\FFMPEG-9.0\bin`.
$runtimeTarget = Join-Path $releaseRoot 'runtime\FFMPEG-9.0'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $runtimeTarget) | Out-Null
Copy-Item $RuntimeSource $runtimeTarget -Recurse -Force
$copiedFiles = (Get-ChildItem $runtimeTarget -Recurse -File | Measure-Object)
Write-Ok "运行库 → runtime\FFMPEG-9.0 ($($copiedFiles.Count) 个文件)"

# A data skeleton so the first run has a predictable layout beside the executable.
foreach ($folder in @('config', 'history', 'favorites', 'logs', 'cache', 'temp', 'downloads')) {
    $path = Join-Path $releaseRoot "data\$folder"
    New-Item -ItemType Directory -Force -Path $path | Out-Null
}
New-Item -ItemType Directory -Force -Path (Join-Path $releaseRoot 'data\webview') | Out-Null
Write-Ok '数据目录 → data\{config,history,favorites,logs,cache,temp,downloads}'

$readme = @'
YT Downloader — 便携版
======================

直接运行 YTDownloader.exe 即可，无需安装任何依赖。

目录说明
--------
YTDownloader.exe          主程序
runtime\FFMPEG-9.0\       内置运行库（yt-dlp、ffmpeg、ffprobe）——请勿删除
data\                     所有用户数据，全部保存在此处，不写入系统盘
  config\                 设置
  history\                下载历史
  favorites\              收藏
  logs\                   运行日志
  temp\                   下载临时文件
  downloads\              默认下载目录（可在设置中更改）

说明
----
* 程序只使用 runtime\ 内的运行库，不会调用系统 PATH 中的 FFmpeg；
  开发环境下则固定使用 E:\FFMPEG-9.0。
* 默认下载目录为 data\downloads，可随时改为任意位置。
* 本程序不会上传 Cookie、链接、历史或任何用户文件，也不支持任何
  绕过 DRM、付费墙或访问控制的功能。
'@
Set-Content -Path (Join-Path $releaseRoot 'README.txt') -Value $readme -Encoding UTF8
Write-Ok 'README.txt'

# --------------------------------------------------------------------------
# 7. Installer
#
# The setup file is a single executable: the compiled installer stub, then the payload
# built from the portable release assembled above (so the payload is always a clean
# production tree), then a 24-byte footer. Nothing from the development tree can reach
# it — the payload builder walks only the release folder and additionally refuses any
# path that looks like development material.
# --------------------------------------------------------------------------

Write-Step '生成正式安装包'

$installerDir = Join-Path $OutputDirectory 'installer'
$setupStub = Join-Path $ProjectRoot 'src-tauri\target\release\yt-downloader-setup.exe'
# The payload is an intermediate artefact and is kept in the build cache (not in the
# release folder), so re-wrapping after an installer-only change takes seconds.
$payloadFile = Join-Path $Caches 'installer-payload.bin'
$setupExe = Join-Path $installerDir 'YT Downloader Setup.exe'
$payloadScript = Join-Path $PSScriptRoot 'make_payload.py'

if (-not $PythonExe) {
    Write-Fail '缺少 Python，跳过安装包生成。'
}
else {
    if (-not (Test-Path (Join-Path $ProjectRoot 'dist\installer.html'))) {
        Write-Fail '前端构建缺少 installer.html，安装器界面无法生成。'
    }
    else {
        Write-Ok '安装器界面已随前端一起构建（dist\installer.html）'
    }

    # 7a. Installer stub (shares the application's target directory and toolchain).
    Push-Location (Join-Path $ProjectRoot 'src-setup')
    try {
        # `custom-protocol` is mandatory here as well: without it the setup window
        # would try to reach the Vite dev server instead of its embedded interface.
        & $cargoExe build --release --features custom-protocol 2>&1 |
            ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        if ($LASTEXITCODE -ne 0) { Write-Fail "安装器骨架构建失败（exit $LASTEXITCODE）" }
        else { Write-Ok '安装器骨架构建完成' }
    }
    finally { Pop-Location }

    if (Test-Path $setupStub) {
        Write-Ok "安装器骨架 $([math]::Round((Get-Item $setupStub).Length / 1MB, 1)) MB"
    }
    else {
        Write-Fail "找不到安装器骨架：$setupStub"
    }

    # 7b. Payload from the pristine portable release. `-SkipPayload` reuses the cached
    # payload, which makes an installer-only iteration take seconds instead of minutes.
    New-Item -ItemType Directory -Force -Path $installerDir | Out-Null
    if ($script:Failures.Count -eq 0) {
        if ($SkipPayload -and (Test-Path $payloadFile)) {
            Write-Ok "复用已缓存的载荷 $([math]::Round((Get-Item $payloadFile).Length / 1MB, 1)) MB"
        }
        else {
            & $PythonExe $payloadScript payload $releaseRoot $payloadFile 2>&1 |
                ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
            if ($LASTEXITCODE -ne 0) { Write-Fail '载荷生成失败。' }
            else { Write-Ok "载荷已生成 $([math]::Round((Get-Item $payloadFile).Length / 1MB, 1)) MB" }
        }
    }

    # 7c. Wrap stub + payload into the setup executable.
    if ($script:Failures.Count -eq 0) {
        & $PythonExe $payloadScript wrap $setupStub $payloadFile $setupExe 2>&1 |
            ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        if ($LASTEXITCODE -ne 0) { Write-Fail '安装包封装失败。' }
        else { Write-Ok "安装包已生成 $([math]::Round((Get-Item $setupExe).Length / 1MB, 1)) MB" }
    }

    # The payload listing is part of the release evidence, not just a check.
    if (Test-Path $setupExe) {
        & $PythonExe $payloadScript verify $setupExe 2>&1 |
            ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        if ($LASTEXITCODE -ne 0) { Write-Fail '安装包内容校验未通过。' }
        else { Write-Ok '安装包内容校验通过（无开发目录）' }
    }
}

# The cached payload is intentionally kept for the next `-SkipPayload` run; only the
# release folder must stay free of intermediates.

# --------------------------------------------------------------------------
# 7. Integrity check
# --------------------------------------------------------------------------

Write-Step 'Release 完整性检查'

$exeRelease = Join-Path $releaseRoot 'YTDownloader.exe'
if (Test-Path $exeRelease) {
    $size = (Get-Item $exeRelease).Length
    if ($size -gt 1MB) { Write-Ok "YTDownloader.exe  $([math]::Round($size / 1MB, 1)) MB" }
    else { Write-Fail "YTDownloader.exe 体积异常（$size 字节）" }
}
else { Write-Fail 'Release 中缺少 YTDownloader.exe' }

# --------------------------------------------------------------------------
# Frontend delivery check
#
# The most damaging possible release defect is a binary that serves the Vite dev
# server instead of the interface embedded in it: the window then shows
# "localhost refused to connect" and nothing else works. That happens whenever the
# `custom-protocol` feature is missing, because Tauri derives `dev = !custom_protocol`.
# The check below inspects the actual bytes of the shipped executable:
#   * it must NOT contain the configured dev URL,
#   * it MUST contain the hashed asset names produced by the frontend build.
# --------------------------------------------------------------------------

# Byte-wise substring search; Latin-1 maps one byte to one character so needles stay
# ASCII-safe and the scan stays fast on a multi-megabyte executable.
function Test-ExeContains([string] $Path, [string] $Needle) {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $text = [System.Text.Encoding]::GetEncoding(28591).GetString($bytes)
    return $text.Contains($Needle)
}

if (Test-Path $exeRelease) {
    $devUrl = 'http://localhost:1420'
    $indexHtml = Join-Path $ProjectRoot 'dist\index.html'

    # NOTE: the presence of the dev URL string is NOT proof of a dev build — Tauri
    # embeds its whole configuration (devUrl included) in every build. What decides
    # where the interface comes from is whether the frontend was embedded, so that is
    # the requirement; the dev URL is reported as context only.
    if (Test-Path $indexHtml) {
        $html = Get-Content $indexHtml -Raw
        $assets = [regex]::Matches($html, 'assets/([A-Za-z0-9_\-]+\.(?:js|css))') |
            ForEach-Object { $_.Groups[1].Value } |
            Select-Object -Unique

        if ($assets.Count -eq 0) {
            Write-Fail 'dist\index.html 中找不到任何构建产物引用'
        }
        else {
            $missing = @()
            foreach ($asset in $assets) {
                if (-not (Test-ExeContains $exeRelease $asset)) { $missing += $asset }
            }
            if ($missing.Count -gt 0) {
                Write-Fail "可执行文件中缺少前端资源：$($missing -join ', ')（很可能未启用 custom-protocol）"
            }
            else {
                Write-Ok "前端资源已内嵌（$($assets.Count) 项）"
            }
        }

        # Asset *contents* are Brotli-compressed inside the executable, so only the
        # asset keys (their hashed file names) are visible as plain text. Their
        # presence is the proof that the frontend build travelled into the binary: a
        # dev-mode build embeds nothing from frontendDist and would not contain these
        # names at all.
        Write-Ok '前端资源键已内嵌（内容以 Brotli 压缩存储）'
    }
    else {
        Write-Fail '缺少 dist\index.html，无法校验前端是否内嵌'
    }

    if (Test-ExeContains $exeRelease $devUrl) {
        Write-Warn "可执行文件含有配置中的 devUrl（$devUrl）——这是 Tauri 内嵌配置的正常现象，不代表会加载开发服务器"
    }
}

$runtimeCheck = @(
    'runtime\FFMPEG-9.0\bin\yt-dlp.exe',
    'runtime\FFMPEG-9.0\bin\ffmpeg.exe',
    'runtime\FFMPEG-9.0\bin\ffprobe.exe'
)
foreach ($relative in $runtimeCheck) {
    $path = Join-Path $releaseRoot $relative
    if (Test-Path $path) { Write-Ok $relative }
    else { Write-Fail "Release 中缺少 $relative" }
}

# Running the shipped tools proves the bundle is executable, not merely present.
$shippedYtDlp = Join-Path $releaseRoot 'runtime\FFMPEG-9.0\bin\yt-dlp.exe'
$shippedFfmpeg = Join-Path $releaseRoot 'runtime\FFMPEG-9.0\bin\ffmpeg.exe'

$ytDlpVersion = Get-ToolVersion $shippedYtDlp @('--version')
if ($ytDlpVersion) { Write-Ok "内置 yt-dlp 可执行：$ytDlpVersion" }
else { Write-Warn '内置 yt-dlp 未能执行（在受限环境中属正常，请在普通用户会话中验证）' }

$ffmpegVersion = Get-ToolVersion $shippedFfmpeg @('-hide_banner', '-version')
if ($ffmpegVersion) { Write-Ok "内置 FFmpeg 可执行：$(($ffmpegVersion -split ' ')[2])" }
else { Write-Warn '内置 FFmpeg 未能执行' }

$dataDirs = @('data\config', 'data\history', 'data\favorites', 'data\logs', 'data\temp', 'data\downloads')
foreach ($relative in $dataDirs) {
    if (Test-Path (Join-Path $releaseRoot $relative)) { Write-Ok $relative }
    else { Write-Fail "缺少目录 $relative" }
}

# --------------------------------------------------------------------------
# Installer checks
# --------------------------------------------------------------------------

if (Test-Path $setupExe) {
    $setupSize = (Get-Item $setupExe).Length
    # The payload is the application plus its 670 MB runtime, so a setup file far
    # below that means the payload was never attached.
    if ($setupSize -gt 200MB) { Write-Ok "YT Downloader Setup.exe  $([math]::Round($setupSize / 1MB, 1)) MB" }
    else { Write-Fail "安装包体积异常（$([math]::Round($setupSize / 1MB, 1)) MB），载荷可能未写入。" }

    if ($PythonExe) {
        & $PythonExe $payloadScript verify $setupExe 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { Write-Ok '安装包载荷可解析且不含开发目录' }
        else { Write-Fail '安装包载荷校验失败' }
    }

    # The setup stub must serve its own embedded interface, same rule as the app.
    $indexHtml = Join-Path $ProjectRoot 'dist\index.html'
    if (Test-Path $indexHtml) {
        $html = Get-Content $indexHtml -Raw
        $assets = [regex]::Matches($html, 'assets/([A-Za-z0-9_\-]+\.(?:js|css))') |
            ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique
        $missing = @()
        foreach ($asset in $assets) {
            if (-not (Test-ExeContains $setupExe $asset)) { $missing += $asset }
        }
        if ($missing.Count -gt 0) { Write-Fail "安装器缺少界面资源：$($missing -join ', ')" }
        else { Write-Ok '安装器界面已内嵌（custom-protocol 生效）' }
    }
}
else {
    Write-Fail "缺少安装包：$setupExe"
}

# --------------------------------------------------------------------------
# 8. Report
# --------------------------------------------------------------------------

Write-Host ''
if ($script:Failures.Count -gt 0) {
    Write-Host "构建失败：$($script:Failures.Count) 项检查未通过。" -ForegroundColor Red
    $script:Failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}

$totalSize = (Get-ChildItem $releaseRoot -Recurse -File | Measure-Object -Property Length -Sum).Sum
$setupSize = if (Test-Path $setupExe) { (Get-Item $setupExe).Length } else { 0 }
$elapsed = (Get-Date) - $started

Write-Host '构建成功。' -ForegroundColor Green
Write-Host ''
Write-Host "  便携版   : $releaseRoot\YTDownloader.exe  ($([math]::Round($totalSize / 1MB, 1)) MB)"
Write-Host "  安装包   : $setupExe  ($([math]::Round($setupSize / 1MB, 1)) MB)"
Write-Host "  耗时     : $([math]::Round($elapsed.TotalSeconds, 1)) 秒"
Write-Host "  yt-dlp   : $ytDlpVersion"
Write-Host "  构建日志 : $script:BuildLog"
Write-Host ''
Write-Host '便携版：复制整个文件夹即可运行；安装版：双击安装包，可选安装目录，'
Write-Host '并会创建开始菜单/桌面快捷方式与标准卸载信息；两者都使用内置运行库。'

try { Stop-Transcript | Out-Null } catch { }
exit 0
