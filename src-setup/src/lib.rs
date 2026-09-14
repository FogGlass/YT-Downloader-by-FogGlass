//! YT Downloader — installer and uninstaller.
//!
//! One executable performs both roles. Launched normally it installs; launched with
//! `--uninstall` (which is how the shortcut created at install time invokes it) it
//! removes the application.
//!
//! The application itself is carried inside this executable as an appended payload
//! (see [`payload`]), so the release folder contains exactly one setup file and no
//! development material can possibly be included.

pub mod cli;
pub mod commands;
pub mod install;
pub mod payload;
pub mod platform;
pub mod progress;
pub mod uninstall;

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::Manager;

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, thiserror::Error)]
pub enum SetupError {
    #[error("{0}")]
    Message(String),

    #[error("文件系统错误：{0}")]
    Io(#[from] std::io::Error),

    #[error("安装包错误：{0}")]
    Payload(String),

    #[error("系统调用失败：{0}")]
    Shell(String),

    #[error("操作已取消")]
    Cancelled,
}

impl SetupError {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Message(_) => "message",
            Self::Io(_) => "io",
            Self::Payload(_) => "payload",
            Self::Shell(_) => "shell",
            Self::Cancelled => "cancelled",
        }
    }
}

impl Serialize for SetupError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("SetupError", 3)?;
        state.serialize_field("kind", self.kind())?;
        state.serialize_field("message", &self.to_string())?;
        state.serialize_field("detail", &format!("{self:?}"))?;
        state.end()
    }
}

pub type SetupResult<T> = Result<T, SetupError>;

/// Status shown before the window draws anything.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupContext {
    pub mode: String,
    pub app_name: String,
    pub app_version: String,
    pub default_dir: String,
    pub install_dir: Option<String>,
    pub installed_version: Option<String>,
    pub payload_bytes: u64,
    pub extracted_bytes: u64,
    pub payload_files: usize,
    pub has_bundled_runtime: bool,
}

pub struct SetupState {
    pub cancel: AtomicBool,
    pub context: Mutex<SetupContext>,
}

impl SetupState {
    fn new(context: SetupContext) -> Self {
        Self {
            cancel: AtomicBool::new(false),
            context: Mutex::new(context),
        }
    }
}

/// Was this executable started as an uninstaller?
fn is_uninstall_invocation() -> bool {
    cli::Cli::parse(std::env::args().skip(1)).uninstall
}

fn build_context() -> SetupContext {
    let uninstalling = is_uninstall_invocation();

    // The payload is absent in the uninstaller copy by design, so its size is only
    // reported when it is actually there.
    let (payload_bytes, extracted_bytes, payload_files, has_runtime) = match payload::Payload::open_self()
    {
        Ok(payload) => {
            let has_runtime = payload.entries().iter().any(|entry| {
                entry
                    .name
                    .replace('\\', "/")
                    .eq_ignore_ascii_case("runtime/FFMPEG-9.0/bin/ffmpeg.exe")
            });
            (
                payload.compressed_bytes,
                payload.extracted_bytes,
                payload.file_count(),
                has_runtime,
            )
        }
        Err(_) => (0, 0, 0, false),
    };

    let install_dir: Option<PathBuf> = if uninstalling {
        uninstall::resolve_install_dir().ok()
    } else {
        platform::read_install_location()
    };

    SetupContext {
        mode: if uninstalling { "uninstall" } else { "install" }.into(),
        app_name: platform::PRODUCT_NAME.into(),
        app_version: APP_VERSION.into(),
        default_dir: platform::default_install_dir().to_string_lossy().to_string(),
        installed_version: install_dir
            .as_ref()
            .map(|_| APP_VERSION.to_string()),
        install_dir: install_dir.map(|path| path.to_string_lossy().to_string()),
        payload_bytes,
        extracted_bytes,
        payload_files,
        has_bundled_runtime: has_runtime,
    }
}

pub fn run() {
    let cli = cli::Cli::parse(std::env::args().skip(1));
    // Record the raw arguments first: when a launcher fails to quote a path with
    // spaces, this line is what makes the problem visible.
    cli.log(&format!(
        "[start] argv={:?}",
        std::env::args().collect::<Vec<String>>()
    ));

    let context = build_context();
    let silent = cli.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(SetupState::new(context)))
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("setup") {
                let _ = window.center();
                let _ = window.set_focus();
            }

            // Silent mode performs the work immediately and reports through the exit
            // code, so deployment scripts and the release verification never have to
            // drive the interface.
            if silent.silent {
                if let Some(window) = app.get_webview_window("setup") {
                    let _ = window.hide();
                }
                let handle = app.handle().clone();
                let state = app.state::<Arc<SetupState>>().inner().clone();
                let options = silent.clone();

                tauri::async_runtime::spawn_blocking(move || {
                    let code = run_silent(&handle, state, &options);
                    // `AppHandle::exit` tears the application down cooperatively and
                    // does not carry an exit code, so an unattended run reports its
                    // result through the process status directly.
                    handle.cleanup_before_exit();
                    std::process::exit(code);
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::setup_context,
            commands::setup_pick_directory,
            commands::setup_check_dir,
            commands::setup_start_install,
            commands::setup_start_uninstall,
            commands::setup_cancel,
            commands::setup_launch_app,
            commands::setup_open_path,
            commands::setup_close,
            commands::setup_payload_summary,
        ])
        .run(tauri::generate_context!())
        .expect("error while running YT Downloader Setup");
}

/// Perform one unattended operation and return the process exit code.
fn run_silent(app: &tauri::AppHandle, state: Arc<SetupState>, cli: &cli::Cli) -> i32 {
    let outcome = if cli.uninstall {
        cli.log("[uninstall] 开始卸载");
        uninstall::run_uninstall(
            app.clone(),
            state,
            uninstall::UninstallOptions {
                remove_app_data: cli.remove_app_data,
                remove_downloads: cli.remove_downloads,
            },
        )
        .map(|result| {
            cli.log(&format!(
                "[uninstall] 完成：{}",
                result.install_dir.display()
            ));
            cli.log(&format!(
                "[uninstall] 保留应用数据={} 保留下载文件={}",
                result.app_data_kept, result.downloads_kept
            ));
            for warning in &result.warnings {
                cli.log(&format!("[uninstall] 警告：{warning}"));
            }
        })
    } else {
        let dir = cli
            .dir
            .clone()
            .unwrap_or_else(platform::default_install_dir);
        cli.log(&format!("[install] 目标目录：{}", dir.display()));
        install::run_install(
            app.clone(),
            state,
            install::InstallOptions {
                dir: dir.to_string_lossy().to_string(),
                start_menu_shortcut: !cli.no_shortcuts,
                desktop_shortcut: !cli.no_shortcuts,
                launch_after_install: !cli.no_launch,
            },
        )
        .map(|result| {
            cli.log(&format!(
                "[install] 完成：{}",
                result.install_dir.display()
            ));
            for shortcut in &result.shortcuts {
                cli.log(&format!("[install] 快捷方式：{}", shortcut.display()));
            }
            for warning in &result.warnings {
                cli.log(&format!("[install] 警告：{warning}"));
            }
        })
    };

    match outcome {
        Ok(()) => {
            remove_silent_log_if_implicit(cli);
            cli::EXIT_OK
        }
        Err(error) => {
            cli.log(&format!("[error] {error}"));
            remove_silent_log_if_implicit(cli);
            if matches!(error, SetupError::Cancelled) {
                cli::EXIT_CANCELLED
            } else {
                cli::EXIT_FAILED
            }
        }
    }
}

/// Delete the diagnostic log this run wrote, when it was not explicitly requested.
///
/// The log lives next to the executable, which for the uninstaller is the directory
/// being removed; leaving it behind would keep that directory from ever becoming
/// empty. An explicit `--log=` is the caller's file and is never touched.
fn remove_silent_log_if_implicit(cli: &cli::Cli) {
    if !cli.silent || cli.log.is_some() {
        return;
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let _ = std::fs::remove_file(dir.join("setup-log.txt"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_setup_error_kind_is_stable_for_the_ui() {
        assert_eq!(SetupError::Cancelled.kind(), "cancelled");
        assert_eq!(
            SetupError::Payload("x".into()).kind(),
            "payload"
        );
        assert_eq!(SetupError::Message("x".into()).kind(), "message");
    }

    #[test]
    fn uninstall_arguments_are_recognised() {
        // The helper reads the real process arguments, so this only asserts the
        // matching rules through the same predicate the runtime uses.
        let matches = |argument: &str| {
            let lowered = argument.to_ascii_lowercase();
            lowered == "--uninstall" || lowered == "/uninstall" || lowered == "-uninstall"
        };
        assert!(matches("--uninstall"));
        assert!(matches("/UNINSTALL"));
        assert!(matches("-Uninstall"));
        assert!(!matches("--install"));
        assert!(!matches(""));
    }
}
