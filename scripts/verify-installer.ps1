<#
.SYNOPSIS
    End-to-end verification of the YT Downloader installer.

.DESCRIPTION
    Builds nothing: it exercises the finished setup file exactly as a user would, using
    the installer's silent switches so the whole cycle can run unattended.

    Cycle 1  install  → assert files, shortcuts, registry, runtime
             uninstall (keep downloads) → assert program removed, user media kept
    Cycle 2  install  → uninstall (remove everything) → assert the directory is gone

    The user media files it creates are its own test artefacts inside the temporary
    install directory; no real user data is touched.

.PARAMETER SetupPath
    The setup file to verify. Defaults to release\installer\YT Downloader Setup.exe.

.PARAMETER InstallDir
    Temporary installation directory. Must be on a non-system drive.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\verify-installer.ps1
#>

[CmdletBinding()]
param(
    [string] $SetupPath,
    [string] $InstallDir
)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Workspace = Split-Path -Parent $ProjectRoot
if (-not $SetupPath) {
    $SetupPath = Join-Path $ProjectRoot 'release\installer\YT Downloader Setup.exe'
}
if (-not $InstallDir) {
    # Inside the workspace by default: the verification installs and uninstalls 670 MB and
    # must never claim a real location, while still exercising a path with a space in it.
    $InstallDir = Join-Path $Workspace '.caches\install-test'
}

$script:Passed = 0
$script:Failures = @()

function Check([bool] $Condition, [string] $Message) {
    if ($Condition) {
        Write-Host "  ok   $Message" -ForegroundColor Green
        $script:Passed++
    }
    else {
        Write-Host "  FAIL $Message" -ForegroundColor Red
        $script:Failures += $Message
    }
}

function Format-Arguments([string[]] $Arguments) {
    # `Start-Process -ArgumentList` joins an array with spaces and never quotes, so any
    # argument containing a space would reach the installer split into several arguments.
    # That matters here: the default install target lives under "YTDownloader" inside a
    # workspace path that itself contains a space, and a real user path
    # ("E:\YT Downloader") has one too. Quoting is therefore part of the test.
    ($Arguments | ForEach-Object {
            if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
        }) -join ' '
}

function Run-Uninstaller([string[]] $Arguments) {
    # The installed uninstaller, which is what the Start Menu entry launches.
    $exe = Join-Path $InstallDir 'uninstall.exe'
    if (-not (Test-Path $exe)) { return 127 }
    $process = Start-Process -FilePath $exe -ArgumentList (Format-Arguments $Arguments) -Wait -PassThru
    return $process.ExitCode
}
function Run-Setup([string[]] $Arguments) {
    # The setup is a GUI-subsystem executable: PowerShell must be told to wait.
    $process = Start-Process -FilePath $SetupPath -ArgumentList (Format-Arguments $Arguments) -Wait -PassThru
    return $process.ExitCode
}

$registryKey = 'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\YT Downloader'
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\YT Downloader'
# The Desktop can be redirected (OneDrive, for instance); ask the shell for the real one.
$desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'YT Downloader.lnk'

Write-Host ''
Write-Host 'YT Downloader — 安装包验证' -ForegroundColor White
Write-Host "  安装包   : $SetupPath"
Write-Host "  安装目录 : $InstallDir"
Write-Host ''

if (-not (Test-Path $SetupPath)) {
    Write-Host "找不到安装包：$SetupPath" -ForegroundColor Red
    exit 1
}
if ($InstallDir.ToUpper().StartsWith('C:')) {
    Write-Host '安装目录不得位于系统盘（本脚本用于临时验证）。' -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------------------
Write-Host '[1] 干净安装' -ForegroundColor Cyan
# ---------------------------------------------------------------------------

Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
if (Test-Path $startMenu) { Remove-Item $startMenu -Recurse -Force -ErrorAction SilentlyContinue }

$sw = [Diagnostics.Stopwatch]::StartNew()
$code = Run-Setup @('--silent', "--dir=$InstallDir", '--no-launch')
$elapsed = [math]::Round($sw.Elapsed.TotalSeconds, 1)

Check ($code -eq 0) "安装器退出码为 0（实际 $code）"
Check (Test-Path (Join-Path $InstallDir 'YTDownloader.exe')) '主程序已安装'
Check (Test-Path (Join-Path $InstallDir 'uninstall.exe')) '卸载程序已安装'
Check (Test-Path (Join-Path $InstallDir 'runtime\FFMPEG-9.0\bin\ffmpeg.exe')) '内置 ffmpeg 已安装'
Check (Test-Path (Join-Path $InstallDir 'runtime\FFMPEG-9.0\bin\ffprobe.exe')) '内置 ffprobe 已安装'
Check (Test-Path (Join-Path $InstallDir 'runtime\FFMPEG-9.0\bin\yt-dlp.exe')) '内置 yt-dlp 已安装'
Check (Test-Path (Join-Path $InstallDir 'data\downloads')) 'data\downloads 目录已创建'
Check (Test-Path (Join-Path $InstallDir 'data\config')) 'data\config 目录已创建'
Check (Test-Path $startMenu) '开始菜单快捷方式已创建'
Check (Test-Path (Join-Path $startMenu '卸载 YT Downloader.lnk')) '开始菜单中包含卸载入口'

$uninstallerSize = (Get-Item (Join-Path $InstallDir 'uninstall.exe')).Length
Check ($uninstallerSize -lt 20MB) "卸载程序不含载荷（$([math]::Round($uninstallerSize / 1MB, 1)) MB）"

$registry = reg query $registryKey 2>&1 | Out-String
Check ($registry -match 'YT Downloader') '注册表卸载项已写入'
Check ($registry -match [regex]::Escape($InstallDir)) '注册表记录了安装位置'
Write-Host "       安装耗时 $elapsed 秒"

# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '[2] 卸载（保留用户数据）' -ForegroundColor Cyan
# ---------------------------------------------------------------------------

# Simulated downloads, including one in a folder the user picked themselves.
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir 'data\downloads') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir 'data\我的影片') | Out-Null
Set-Content -Path (Join-Path $InstallDir 'data\downloads\测试视频.webm') -Value 'user-video'
Set-Content -Path (Join-Path $InstallDir 'data\我的影片\另一部.mp4') -Value 'user-movie'
Set-Content -Path (Join-Path $InstallDir 'data\config\settings.json') `
    -Value ('{"downloads":{"outputDir":"' + ($InstallDir -replace '\\', '\\') + '\\data\\我的影片"}}')

$code = Run-Uninstaller @('--uninstall', '--silent', '--remove-app-data')
Start-Sleep -Seconds 6   # the uninstaller deletes itself from a detached shell

Check ($code -eq 0) "卸载器退出码为 0（实际 $code）"
Check (-not (Test-Path (Join-Path $InstallDir 'YTDownloader.exe'))) '主程序已删除'
Check (-not (Test-Path (Join-Path $InstallDir 'runtime'))) '运行库目录已删除'
Check (-not (Test-Path (Join-Path $InstallDir 'README.txt'))) 'README 已删除'
Check (-not (Test-Path (Join-Path $InstallDir 'uninstall.exe'))) '卸载程序已自删除'
Check (-not (Test-Path (Join-Path $InstallDir 'data\config'))) '应用设置已删除（已选择清理）'
Check (-not (Test-Path (Join-Path $InstallDir 'data\logs'))) '日志已删除（已选择清理）'
Check (Test-Path (Join-Path $InstallDir 'data\downloads\测试视频.webm')) '用户下载文件未被删除'
Check (Test-Path (Join-Path $InstallDir 'data\我的影片\另一部.mp4')) '自定义下载目录中的文件未被删除'
Check (-not (Test-Path $startMenu)) '开始菜单快捷方式已移除'
Check (-not (Test-Path $desktopLink)) '桌面快捷方式已移除'
$registryAfter = reg query $registryKey 2>&1 | Out-String
Check ($registryAfter -match 'unable to find|找不到') '注册表卸载项已移除'

# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '[3] 卸载（同时删除用户数据）' -ForegroundColor Cyan
# ---------------------------------------------------------------------------

# Start from a clean baseline: cycle 2 deliberately left a user file behind in a
# custom folder, which is exactly what an uninstaller is supposed to do.
Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue

$code = Run-Setup @('--silent', "--dir=$InstallDir", '--no-launch', '--no-shortcuts')
Check ($code -eq 0) "第二次安装退出码为 0（实际 $code）"
Set-Content -Path (Join-Path $InstallDir 'data\downloads\待删除.webm') -Value 'user-video'

$code = Run-Uninstaller @('--uninstall', '--silent', '--remove-app-data', '--remove-downloads')
Start-Sleep -Seconds 6

Check ($code -eq 0) "第二次卸载退出码为 0（实际 $code）"
Check (-not (Test-Path (Join-Path $InstallDir 'YTDownloader.exe'))) '主程序已删除'
Check (-not (Test-Path (Join-Path $InstallDir 'data\downloads\待删除.webm'))) '用户下载文件已按选择删除'
Check (-not (Test-Path $InstallDir)) '安装目录已完全清理（无残留）'

# ---------------------------------------------------------------------------
Write-Host ''
if ($script:Failures.Count -gt 0) {
    Write-Host "验证失败：$($script:Failures.Count) 项未通过，$($script:Passed) 项通过。" -ForegroundColor Red
    $script:Failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}

Write-Host "安装包验证全部通过（$($script:Passed) 项检查）。" -ForegroundColor Green
exit 0
