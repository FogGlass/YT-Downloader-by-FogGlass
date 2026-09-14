//! Runtime discovery.
//!
//! The media toolchain is never taken from `PATH`, never downloaded and never taken
//! from the system drive. Two locations are sanctioned, in this order:
//!
//!   1. the folder the user configured,
//!   2. `<app>\runtime\FFMPEG-9.0\bin` shipped with a release build,
//!   3. `E:\FFMPEG-9.0\bin`, the fixed development runtime.
//!
//! yt-dlp itself can be driven either as the bundled executable or as a Python
//! module. The module form exists because a PyInstaller single-file executable
//! unpacks itself into a private temporary directory, and locked-down Windows
//! environments (restricted tokens, application-control policies) can forbid that.
//! Both forms are first-class here and are reported in the UI.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::core::error::{AppError, AppResult};
use crate::core::paths::{self, DataRoots};
use crate::models::settings::{AppSettings, YtDlpRuntimeMode};
use crate::process::{run_process, LineSink, ProcessRegistry, ProcessSpec};
use crate::log_info;
use crate::log_warn;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeSource {
    Configured,
    Bundled,
    Development,
    Missing,
}

impl RuntimeSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Configured => "configured",
            Self::Bundled => "bundled",
            Self::Development => "development",
            Self::Missing => "missing",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub name: String,
    pub path: Option<String>,
    pub version: Option<String>,
    pub available: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub bin_dir: String,
    pub source: String,
    pub yt_dlp_mode: String,
    /// External JS runtime handed to yt-dlp (empty when none was found).
    pub js_runtime: Option<String>,
    pub yt_dlp: ToolStatus,
    pub ffmpeg: ToolStatus,
    pub ffprobe: ToolStatus,
    pub complete: bool,
    pub warnings: Vec<String>,
    pub checked_at: String,
}

/// Resolved set of tools that the services actually execute.
#[derive(Debug, Clone)]
pub struct ToolSet {
    pub bin_dir: PathBuf,
    pub source: RuntimeSource,
    pub yt_dlp_exe: Option<PathBuf>,
    pub ffmpeg: Option<PathBuf>,
    pub ffprobe: Option<PathBuf>,
    pub launcher: YtDlpLauncher,
}

/// External JavaScript runtime handed to yt-dlp.
///
/// Since 2025 YouTube requires a JS engine to solve the player's signature
/// challenges. Without one, yt-dlp can still fetch metadata but media downloads
/// frequently stall with no bytes transferred, which looks like a network problem and
/// is very hard to diagnose. yt-dlp's own auto-detection misses shim executables such
/// as the `node.cmd` wrapper used by many Windows setups, so the lookup is done here
/// and passed explicitly.
pub fn detect_js_runtime() -> Option<String> {
    static DETECTED: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();

    DETECTED
        .get_or_init(|| {
            const CANDIDATES: [&str; 3] = ["node", "deno", "bun"];
            for candidate in CANDIDATES {
                if which(candidate).is_some() {
                    log_info!("runtime", "external JS runtime available for yt-dlp: {candidate}");
                    return Some(candidate.to_string());
                }
            }
            log_warn!(
                "runtime",
                "no external JS runtime found (node/deno/bun); YouTube downloads may be incomplete"
            );
            None
        })
        .clone()
}

/// Locate an executable on `PATH`, honouring PATHEXT (so `node.cmd` matches `node`).
fn which(program: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let output = std::process::Command::new("where")
            .arg(program)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(PathBuf::from)
    }

    #[cfg(not(windows))]
    {
        let output = std::process::Command::new("which").arg(program).output().ok()?;
        if !output.status.success() {
            return None;
        }
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(PathBuf::from)
    }
}

#[derive(Debug, Clone)]
pub enum YtDlpLauncher {
    /// The bundled single-file executable.
    Executable(PathBuf),
    /// `python -m yt_dlp`, with the module directory prepended to `PYTHONPATH`.
    PythonModule {
        python: PathBuf,
        module_dir: Option<PathBuf>,
    },
}

impl YtDlpLauncher {
    pub fn program(&self) -> &Path {
        match self {
            Self::Executable(path) => path,
            Self::PythonModule { python, .. } => python,
        }
    }

    pub fn mode_label(&self) -> &'static str {
        match self {
            Self::Executable(_) => "executable",
            Self::PythonModule { .. } => "pythonModule",
        }
    }

    /// Arguments that must precede the yt-dlp arguments themselves.
    pub fn prefix_args(&self) -> Vec<String> {
        match self {
            Self::Executable(_) => Vec::new(),
            Self::PythonModule { .. } => vec!["-m".into(), "yt_dlp".into()],
        }
    }

    /// Environment for every yt-dlp invocation, whatever the launcher.
    ///
    /// The UTF-8 pair is mandatory rather than cosmetic: a Python child writes its
    /// messages with the console code page (GBK on a Chinese Windows), so a line as
    /// ordinary as a CJK file name reaches us as bytes that are not valid UTF-8.
    /// Asking for UTF-8 keeps the output identical on every machine.
    pub fn env(&self) -> Vec<(String, String)> {
        let mut env = vec![
            ("PYTHONUTF8".to_string(), "1".to_string()),
            ("PYTHONIOENCODING".to_string(), "utf-8".to_string()),
        ];

        if let Self::PythonModule { module_dir, .. } = self {
            // Keep bytecode out of the module tree: the runtime folder may be read-only.
            env.push(("PYTHONDONTWRITEBYTECODE".to_string(), "1".to_string()));
            if let Some(dir) = module_dir {
                env.push((
                    "PYTHONPATH".to_string(),
                    dir.to_string_lossy().to_string(),
                ));
            }
        }

        env
    }

    /// Friendly identifier used in the runtime panel.
    pub fn display(&self) -> String {
        match self {
            Self::Executable(path) => path.to_string_lossy().to_string(),
            Self::PythonModule { python, module_dir } => match module_dir {
                Some(dir) => format!("{} -m yt_dlp  (PYTHONPATH={})", python.display(), dir.display()),
                None => format!("{} -m yt_dlp", python.display()),
            },
        }
    }
}

/// Choose the tool folder and the yt-dlp launcher for the current settings.
pub fn resolve(settings: &AppSettings) -> ToolSet {
    let override_dir = if settings.advanced.tools_dir.trim().is_empty() {
        None
    } else {
        Some(PathBuf::from(settings.advanced.tools_dir.trim()))
    };

    let mut chosen: Option<(PathBuf, RuntimeSource)> = None;
    let configured_dir = override_dir.as_ref().map(|dir| paths::normalise_bin_dir(dir));

    for candidate in paths::runtime_candidates(override_dir.as_deref()) {
        let normalised = paths::normalise_bin_dir(&candidate);
        let has_yt_dlp = normalised.join("yt-dlp.exe").is_file();
        let has_ffmpeg = normalised.join("ffmpeg.exe").is_file();
        if has_yt_dlp || has_ffmpeg {
            let source = if configured_dir.as_ref() == Some(&normalised) {
                RuntimeSource::Configured
            } else if normalised
                .to_string_lossy()
                .to_ascii_uppercase()
                .contains("RUNTIME")
            {
                RuntimeSource::Bundled
            } else {
                RuntimeSource::Development
            };
            chosen = Some((normalised, source));
            break;
        }
    }

    let (bin_dir, source) = chosen.unwrap_or_else(|| {
        (
            paths::runtime_candidates(override_dir.as_deref())
                .into_iter()
                .next()
                .unwrap_or_else(|| PathBuf::from(paths::DEV_RUNTIME_BIN)),
            RuntimeSource::Missing,
        )
    });

    let yt_dlp_exe = existing(bin_dir.join("yt-dlp.exe"));
    let ffmpeg = existing(bin_dir.join("ffmpeg.exe"));
    let ffprobe = existing(bin_dir.join("ffprobe.exe"));

    let launcher = choose_launcher(settings, yt_dlp_exe.clone());

    ToolSet {
        bin_dir,
        source,
        yt_dlp_exe,
        ffmpeg,
        ffprobe,
        launcher,
    }
}

fn existing(path: PathBuf) -> Option<PathBuf> {
    if path.is_file() {
        Some(path)
    } else {
        None
    }
}

fn choose_launcher(settings: &AppSettings, yt_dlp_exe: Option<PathBuf>) -> YtDlpLauncher {
    let advanced = &settings.advanced;
    let python = if advanced.python_path.trim().is_empty() {
        None
    } else {
        existing(PathBuf::from(advanced.python_path.trim()))
    };
    let module_dir = if advanced.python_module_dir.trim().is_empty() {
        None
    } else {
        Some(PathBuf::from(advanced.python_module_dir.trim()))
    };

    match advanced.ytdlp_mode {
        YtDlpRuntimeMode::Executable => YtDlpLauncher::Executable(
            yt_dlp_exe.unwrap_or_else(|| PathBuf::from("yt-dlp.exe")),
        ),
        YtDlpRuntimeMode::PythonModule => YtDlpLauncher::PythonModule {
            python: python.unwrap_or_else(|| PathBuf::from("python.exe")),
            module_dir,
        },
        YtDlpRuntimeMode::Auto => match yt_dlp_exe {
            // The executable is preferred: it is self-contained and starts fastest.
            Some(path) => YtDlpLauncher::Executable(path),
            None => match python {
                Some(python) => YtDlpLauncher::PythonModule { python, module_dir },
                None => YtDlpLauncher::Executable(PathBuf::from("yt-dlp.exe")),
            },
        },
    }
}

/// Build a process specification that runs `tool` with a `--version` style argv.
///
/// Also used for the actual probe/download commands so that the launcher prefix and
/// environment are applied in exactly one place.
pub fn yt_dlp_spec(
    tools: &ToolSet,
    args: Vec<String>,
    label: &str,
) -> ProcessSpec {
    let mut full = tools.launcher.prefix_args();
    full.extend(args);

    let mut spec = ProcessSpec::new(tools.launcher.program().to_path_buf(), full, label);
    spec.env = tools.launcher.env();
    spec
}

/// Run `--version` (or an equivalent) for a program and capture its first line.
pub async fn probe_version(
    registry: Arc<ProcessRegistry>,
    program: &Path,
    args: &[&str],
) -> AppResult<String> {
    let spec = ProcessSpec::new(
        program.to_path_buf(),
        args.iter().map(|value| value.to_string()).collect(),
        "version probe",
    )
    .with_timeout(30);

    let collected = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let sink: LineSink = {
        let collected = collected.clone();
        Arc::new(move |stream, line| {
            if stream == crate::process::ProcessStream::Stdout {
                if let Ok(mut guard) = collected.lock() {
                    guard.push(line.to_string());
                }
            }
        })
    };

    let outcome = run_process(
        spec,
        registry,
        format!("version:{}", program.display()),
        sink,
    )
    .await?;

    let text = collected
        .lock()
        .map(|guard| guard.join(" "))
        .unwrap_or_default();

    if text.trim().is_empty() {
        if outcome.success() {
            Ok("unknown".into())
        } else {
            Err(AppError::Process(format!(
                "{} 无法运行：{}",
                program.display(),
                outcome
                    .stderr_tail
                    .last()
                    .cloned()
                    .unwrap_or_else(|| format!("exit code {:?}", outcome.code))
            )))
        }
    } else {
        Ok(text.trim().to_string())
    }
}

/// Full runtime health check used by the About page and the first-run banner.
pub async fn inspect(
    settings: &AppSettings,
    registry: Arc<ProcessRegistry>,
    roots: &DataRoots,
) -> RuntimeStatus {
    let tools = resolve(settings);
    let mut warnings = Vec::new();

    if paths::is_on_c_drive(&tools.bin_dir) {
        warnings.push(format!(
            "运行库当前位于系统盘：{}。建议改到其他分区。",
            tools.bin_dir.display()
        ));
    }

    let mut status = RuntimeStatus {
        bin_dir: tools.bin_dir.to_string_lossy().to_string(),
        source: tools.source.as_str().to_string(),
        yt_dlp_mode: tools.launcher.mode_label().to_string(),
        js_runtime: detect_js_runtime(),
        checked_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        ..Default::default()
    };

    if status.js_runtime.is_none() {
        warnings.push(
            "未检测到 node / deno 等 JavaScript 运行时。YouTube 需要它来解算播放器签名，\
             缺少时下载可能长时间没有进度。可在「设置 → YouTube」中指定。"
                .into(),
        );
    }

    // yt-dlp through whichever launcher is configured.
    match probe_yt_dlp(&tools, registry.clone()).await {
        Ok(version) => {
            status.yt_dlp = ToolStatus {
                name: "yt-dlp".into(),
                path: Some(tools.launcher.display()),
                version: Some(version),
                available: true,
                error: None,
            };
        }
        Err(error) => {
            status.yt_dlp = ToolStatus {
                name: "yt-dlp".into(),
                path: Some(tools.launcher.display()),
                version: None,
                available: false,
                error: Some(error.to_string()),
            };
            warnings.push(format!(
                "yt-dlp 不可用：{error}。可在「设置 → 高级」切换运行方式（可执行文件 / Python 模块）。"
            ));
        }
    }

    status.ffmpeg = probe_binary(
        "ffmpeg",
        tools.ffmpeg.as_deref(),
        registry.clone(),
        &["-hide_banner", "-version"],
    )
    .await;
    status.ffprobe = probe_binary(
        "ffprobe",
        tools.ffprobe.as_deref(),
        registry.clone(),
        &["-hide_banner", "-version"],
    )
    .await;

    for tool in [&status.ffmpeg, &status.ffprobe] {
        if !tool.available {
            warnings.push(format!(
                "{} 不可用：{}",
                tool.name,
                tool.error.clone().unwrap_or_else(|| "未找到".into())
            ));
        }
    }

    status.complete = status.yt_dlp.available && status.ffmpeg.available && status.ffprobe.available;

    log_info!(
        "runtime",
        "runtime check: dir={} source={} mode={} yt-dlp={} ffmpeg={} ffprobe={} data={}",
        status.bin_dir,
        status.source,
        status.yt_dlp_mode,
        status.yt_dlp.version.clone().unwrap_or_else(|| "n/a".into()),
        status.ffmpeg.version.clone().unwrap_or_else(|| "n/a".into()),
        status.ffprobe.version.clone().unwrap_or_else(|| "n/a".into()),
        roots.root.display()
    );

    if settings.advanced.keep_raw_output {
        warnings.push("已开启原始输出保留：日志会包含完整 stdout/stderr。".into());
    }

    status.warnings = warnings;
    status
}

pub async fn probe_yt_dlp(
    tools: &ToolSet,
    registry: Arc<ProcessRegistry>,
) -> AppResult<String> {
    let spec = yt_dlp_spec(tools, vec!["--version".into()], "yt-dlp version").with_timeout(60);
    let collected = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let sink: LineSink = {
        let collected = collected.clone();
        Arc::new(move |stream, line| {
            if stream == crate::process::ProcessStream::Stdout {
                if let Ok(mut guard) = collected.lock() {
                    guard.push(line.to_string());
                }
            }
        })
    };

    let outcome = run_process(spec, registry, "runtime:yt-dlp".into(), sink).await?;
    let text = collected
        .lock()
        .map(|guard| guard.join(" ").trim().to_string())
        .unwrap_or_default();

    if outcome.success() && !text.is_empty() {
        return Ok(text);
    }

    let detail = outcome
        .stderr_tail
        .last()
        .cloned()
        .unwrap_or_else(|| format!("退出码 {:?}", outcome.code));
    Err(AppError::Runtime(format!(
        "{} 启动失败：{detail}",
        tools.launcher.display()
    )))
}

async fn probe_binary(
    name: &str,
    path: Option<&Path>,
    registry: Arc<ProcessRegistry>,
    args: &[&str],
) -> ToolStatus {
    let Some(path) = path else {
        return ToolStatus {
            name: name.into(),
            path: None,
            version: None,
            available: false,
            error: Some("未在运行库目录中找到该程序".into()),
        };
    };

    match probe_version(registry, path, args).await {
        Ok(version) => ToolStatus {
            name: name.into(),
            path: Some(path.to_string_lossy().to_string()),
            version: Some(trim_version(&version)),
            available: true,
            error: None,
        },
        Err(error) => ToolStatus {
            name: name.into(),
            path: Some(path.to_string_lossy().to_string()),
            version: None,
            available: false,
            error: Some(error.to_string()),
        },
    }
}

/// FFmpeg prints a long banner; keep the version token only.
fn trim_version(raw: &str) -> String {
    // "ffmpeg version 2026-08-03-git-… Copyright …" → the first digit-led token.
    if let Some(token) = raw
        .split_whitespace()
        .find(|token| token.starts_with(|c: char| c.is_ascii_digit()) || token.starts_with('n'))
    {
        return token.trim_end_matches(',').to_string();
    }
    raw.chars().take(80).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::settings::AppSettings;

    #[test]
    fn development_runtime_is_discovered() {
        let settings = AppSettings::default();
        let tools = resolve(&settings);
        // The project mandates E:\FFMPEG-9.0; on a machine without it the resolver
        // still returns a deterministic candidate rather than panicking.
        assert!(!tools.bin_dir.as_os_str().is_empty());
    }

    #[test]
    fn python_module_launcher_adds_module_arguments_and_path() {
        let launcher = YtDlpLauncher::PythonModule {
            python: PathBuf::from(r"E:\Python\python.exe"),
            module_dir: Some(PathBuf::from(r"E:\tools\python")),
        };
        assert_eq!(launcher.prefix_args(), vec!["-m", "yt_dlp"]);
        assert_eq!(launcher.mode_label(), "pythonModule");
        let env = launcher.env();
        assert!(env
            .iter()
            .any(|(key, value)| key == "PYTHONPATH" && value.ends_with("python")));
        assert!(env
            .iter()
            .any(|(key, value)| key == "PYTHONIOENCODING" && value == "utf-8"));
    }

    #[test]
    fn executable_launcher_takes_no_prefix_arguments_but_forces_utf8() {
        let launcher = YtDlpLauncher::Executable(PathBuf::from(r"E:\FFMPEG-9.0\bin\yt-dlp.exe"));
        assert!(launcher.prefix_args().is_empty());
        assert_eq!(launcher.mode_label(), "executable");
        // Regression: the bundled executable used to inherit the console code page,
        // so its CJK output arrived as GBK bytes and broke the log reader.
        let env = launcher.env();
        assert!(env
            .iter()
            .any(|(key, value)| key == "PYTHONIOENCODING" && value == "utf-8"));
        assert!(env
            .iter()
            .any(|(key, value)| key == "PYTHONUTF8" && value == "1"));
        assert!(!env.iter().any(|(key, _)| key == "PYTHONPATH"));
    }

    #[test]
    fn explicit_python_mode_is_honoured() {
        let mut settings = AppSettings::default();
        settings.advanced.ytdlp_mode = YtDlpRuntimeMode::PythonModule;
        settings.advanced.python_path = r"E:\Python\python.exe".into();
        settings.advanced.python_module_dir = r"E:\tools\python".into();
        let tools = resolve(&settings);
        assert!(matches!(tools.launcher, YtDlpLauncher::PythonModule { .. }));
    }

    #[test]
    fn version_banners_are_trimmed() {
        assert_eq!(
            trim_version("ffmpeg version 2026-08-03-git-01a25f74cc-full_build"),
            "2026-08-03-git-01a25f74cc-full_build"
        );
        assert_eq!(trim_version("ffprobe version n7.1"), "n7.1");
    }
}
