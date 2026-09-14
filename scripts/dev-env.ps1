# Shared environment for every build/test command in this project.
#
# Why this file exists:
#   * The Rust toolchain lives on C: and is only ever read, never written. Pointing
#     CARGO_HOME at E: keeps every registry/cache write off the system drive.
#   * CARGO_HOME no longer contains rustup's shims, so the real toolchain binaries
#     are put first on PATH. Otherwise the rustup shim tries to sync the channel
#     and fails while writing to C:\Users\<user>\.rustup\downloads.
#   * Node, cargo and MSVC all honour TEMP/TMP, which is pinned to the workspace so
#     no build ever spills into C:\Users\<user>\AppData\Local\Temp.

# NOTE: deliberately NOT 'Stop'. Native tools (cargo, npm, tauri) write progress to
# stderr, and with ErrorActionPreference='Stop' PowerShell turns the first such line
# into a terminating error that kills the whole build.
$ErrorActionPreference = 'Continue'

$script:Workspace = 'E:\DeepSeek Harness Workspace'
$script:Project = Join-Path $script:Workspace 'YTDownloader'
$script:Caches = Join-Path $script:Workspace '.caches'
$script:Toolchain = 'C:\Users\FogGlass\.rustup\toolchains\stable-x86_64-pc-windows-msvc'
$script:Python = 'E:\Python\python.exe'
$script:RuntimeBin = 'E:\FFMPEG-9.0\bin'

foreach ($dir in @($script:Caches, (Join-Path $script:Caches 'temp'), (Join-Path $script:Caches 'npm'), (Join-Path $script:Caches 'cargo'))) {
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
}

$env:YTD_WORKSPACE = $script:Workspace
$env:YTD_PROJECT = $script:Project
$env:YTD_PYTHON = $script:Python
$env:YTD_RUNTIME_BIN = $script:RuntimeBin
$env:YTD_YTDLP_PYTHONPATH = Join-Path $script:Workspace '.tools\python'

$env:CARGO_HOME = Join-Path $script:Caches 'cargo'
$env:CARGO_TARGET_DIR = Join-Path $script:Project 'src-tauri\target'
$env:RUSTC = Join-Path $script:Toolchain 'bin\rustc.exe'
$env:RUSTDOC = Join-Path $script:Toolchain 'bin\rustdoc.exe'
$env:CARGO = Join-Path $script:Toolchain 'bin\cargo.exe'

# Several crates ship a `rust-toolchain.toml`, and build scripts run with their cwd
# inside the crate source. If `rustc` resolves to a rustup shim it tries to install
# that toolchain, which writes to C:\Users\<user>\.rustup and fails. The real
# toolchain binaries ignore toolchain files entirely, so they go first on PATH.
$env:RUSTUP_TOOLCHAIN = $null
$env:RUSTUP_HOME = $null

$env:TEMP = Join-Path $script:Caches 'temp'
$env:TMP = $env:TEMP
$env:npm_config_cache = Join-Path $script:Caches 'npm'
$env:npm_config_audit = 'false'
$env:npm_config_fund = 'false'
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'

# Real toolchain first so `rustc` never resolves to a rustup shim.
$env:PATH = (Join-Path $script:Toolchain 'bin') + ';' + $env:PATH

function Get-CargoPath { $env:CARGO }
function Get-ProjectPath { $script:Project }
function Get-NodePath { (Get-Command node).Source }
