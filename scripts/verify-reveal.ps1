<#
.SYNOPSIS
    Verifies that "定位到文件位置" opens the real folder and selects the real file.

.DESCRIPTION
    Explorer's own window state is the only honest evidence here, so this script creates
    files whose names cover the shapes the application actually produces (ASCII, CJK
    directory, CJK file name, spaces, brackets, fullwidth punctuation), asks the Rust side
    to reveal each one, and then reads the resulting window back through the shell's
    automation interface.

    Every file lives in its own directory on purpose: Explorer reuses one window per
    folder, so sharing a folder would make a passing case look like a failing one.

    It builds nothing and touches nothing outside the workspace.

.PARAMETER TestRoot
    Directory for the temporary test files. Defaults to <workspace>\.caches\reveal-test.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\verify-reveal.ps1
#>

[CmdletBinding()]
param(
    [string] $TestRoot
)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Workspace = Split-Path -Parent $ProjectRoot
if (-not $TestRoot) {
    $TestRoot = Join-Path $Workspace '.caches\reveal-test'
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

function Get-ShellWindows {
    $shell = New-Object -ComObject Shell.Application
    $shell.Windows() | Where-Object { $_.Document } | ForEach-Object {
        $folder = $null
        $selected = $null
        try { $folder = $_.Document.Folder.Self.Path } catch { }
        try { $selected = $_.Document.FocusedItem.Path } catch { }
        [pscustomobject]@{ Folder = $folder; Selected = $selected }
    }
}

function Close-TestWindows {
    $shell = New-Object -ComObject Shell.Application
    $shell.Windows() |
        Where-Object { $_.Document -and $_.Document.Folder -and $_.Document.Folder.Self.Path -like "$TestRoot*" } |
        ForEach-Object { try { $_.Quit() } catch { } }
}

function Wait-ForWindow([string] $Folder, [int] $TimeoutSeconds = 10) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $hit = Get-ShellWindows | Where-Object { $_.Folder -eq $Folder } | Select-Object -First 1
        if ($hit) { return $hit }
        Start-Sleep -Milliseconds 300
    }
    return $null
}

# ---------------------------------------------------------------- test files
# One directory per case, so Explorer never reuses a window between cases.
$cases = @(
    @{ Name = '普通英文路径';        Relative = 'plain\video.mp4' },
    @{ Name = '中文目录';            Relative = '视频\YouTube\video.mp4' },
    @{ Name = '中文文件名';          Relative = '鸣潮\寻心.mp4' },
    @{ Name = '目录与文件名含空格';  Relative = 'YouTube Videos\test video.mp4' },
    @{ Name = '含括号';              Relative = 'brackets\test (1080p).mp4' },
    @{ Name = '混合特殊字符';        Relative = '混合 目录 (x)\【合集】Don''t Stop ！？.mkv' }
)

if (Test-Path $TestRoot) {
    Remove-Item $TestRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host 'YT Downloader — 定位到文件位置 验证' -ForegroundColor Cyan
Write-Host "  测试目录 : $TestRoot"
Write-Host "  项目     : $ProjectRoot"
Write-Host ''

$created = @()
foreach ($case in $cases) {
    $full = Join-Path $TestRoot $case.Relative
    New-Item -ItemType Directory -Force -Path (Split-Path $full -Parent) | Out-Null
    Set-Content -Path $full -Value 'yt-downloader reveal test' -Encoding UTF8
    $created += [pscustomobject]@{ Name = $case.Name; Path = $full; Folder = (Split-Path $full -Parent) }
}
Write-Host "已创建 $($created.Count) 个测试文件（每个都在独立目录中）"

# ------------------------------------------------------------------- runner
. (Join-Path $PSScriptRoot 'dev-env.ps1') | Out-Null
Push-Location (Join-Path $ProjectRoot 'src-tauri')
try {
    Write-Host ''
    Write-Host '编译探针…'
    $build = & cargo test --test reveal_probe --no-run 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        Write-Host $build
        throw '探针编译失败'
    }

    Close-TestWindows
    Start-Sleep -Seconds 1

    foreach ($case in $created) {
        Write-Host ''
        Write-Host "[$($case.Name)] $($case.Path)" -ForegroundColor Cyan

        $env:YTD_REVEAL_PATH = $case.Path
        & cargo test --test reveal_probe -- --nocapture 2>&1 | Out-Null

        $window = Wait-ForWindow $case.Folder
        if (-not $window) {
            Check $false "$($case.Name)：没有打开对应的目录（可能打开了默认目录）"
        }
        else {
            Check ($window.Folder -eq $case.Folder) "$($case.Name)：打开的是文件所在目录"
            Check ($window.Selected -eq $case.Path) "$($case.Name)：目标文件处于选中状态"
        }

        Close-TestWindows
        Start-Sleep -Milliseconds 800
    }
}
finally {
    Pop-Location
    Remove-Item Env:\YTD_REVEAL_PATH -ErrorAction SilentlyContinue
    Close-TestWindows
}

# ------------------------------------------------------------------ summary
Write-Host ''
if ($script:Failures.Count -eq 0) {
    Write-Host "定位验证全部通过（$($script:Passed) 项检查）。" -ForegroundColor Green
    exit 0
}

Write-Host "定位验证失败 $($script:Failures.Count) 项：" -ForegroundColor Red
$script:Failures | ForEach-Object { Write-Host "  - $_" }
exit 1
