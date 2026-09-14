//! Runtime, shell and window commands.

use serde::Serialize;
use tauri::{Manager, State};

use crate::commands::AppState;
use crate::core::error::{AppError, AppResult};
use crate::core::fs_util;
use crate::runtime::{self, RuntimeStatus};
use crate::log_info;

#[tauri::command]
pub async fn runtime_status(state: State<'_, AppState>) -> AppResult<RuntimeStatus> {
    let settings = state.settings.snapshot();
    Ok(runtime::inspect(&settings, state.registry.clone(), &state.roots).await)
}

/// Open a file with its default application.
#[tauri::command]
pub fn open_path(path: String) -> AppResult<()> {
    log_info!("shell", "open {path}");
    fs_util::shell_open(std::path::Path::new(&path))
}

/// Reveal a file in Explorer with the item selected.
#[tauri::command]
pub fn reveal_path(path: String) -> AppResult<()> {
    log_info!("shell", "reveal {path}");
    fs_util::shell_reveal(std::path::Path::new(&path))
}

/// Open a folder in Explorer.
#[tauri::command]
pub fn open_folder(path: String) -> AppResult<()> {
    let path = std::path::Path::new(&path);
    if !path.exists() {
        // Creating it on demand is friendlier than an error when the user has not
        // downloaded anything yet.
        fs_util::ensure_dir(path)?;
    }
    fs_util::shell_open(path)
}

/// Open an http(s) link in the default browser.
#[tauri::command]
pub fn open_url(url: String) -> AppResult<()> {
    log_info!("shell", "open url {url}");
    fs_util::shell_open_url(&url)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathFacts {
    pub exists: bool,
    pub is_file: bool,
    pub is_dir: bool,
    pub size_bytes: u64,
    pub modified_at: Option<String>,
    pub writable: bool,
}

#[tauri::command]
pub fn path_facts(path: String) -> PathFacts {
    let path = std::path::Path::new(&path);
    let metadata = std::fs::metadata(path).ok();
    PathFacts {
        exists: metadata.is_some(),
        is_file: metadata.as_ref().map(|meta| meta.is_file()).unwrap_or(false),
        is_dir: metadata.as_ref().map(|meta| meta.is_dir()).unwrap_or(false),
        size_bytes: metadata.as_ref().map(|meta| meta.len()).unwrap_or(0),
        modified_at: metadata
            .as_ref()
            .and_then(|meta| meta.modified().ok())
            .map(|time| {
                let datetime: chrono::DateTime<chrono::Local> = time.into();
                datetime.format("%Y-%m-%d %H:%M:%S").to_string()
            }),
        writable: writable(path),
    }
}

fn writable(path: &std::path::Path) -> bool {
    let probe = if path.is_dir() || !path.exists() {
        path.join(".ytd-write-probe")
    } else {
        path.to_path_buf()
    };
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&probe)
    {
        Ok(_) => {
            if probe != path {
                let _ = std::fs::remove_file(&probe);
            }
            true
        }
        Err(_) => false,
    }
}

/// Delete a downloaded file (used by History → delete).
#[tauri::command]
pub fn delete_file(path: String) -> AppResult<()> {
    let target = std::path::Path::new(&path);
    if !target.exists() {
        return Err(AppError::NotFound("文件不存在或已被移动".into()));
    }
    log_info!("shell", "delete {path}");
    fs_util::remove_file_quietly(target);
    Ok(())
}

/// Apply appearance settings that live on the native window.
#[tauri::command]
pub fn apply_window_appearance(
    app: tauri::AppHandle,
    native_decorations: bool,
    title: Option<String>,
) -> AppResult<()> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::NotFound("找不到主窗口".into()))?;
    window
        .set_decorations(native_decorations)
        .map_err(|error| AppError::Process(format!("无法切换系统标题栏：{error}")))?;
    if let Some(title) = title {
        let _ = window.set_title(&title);
    }
    Ok(())
}

/// Bring the window back after a minimise-to-tray style action.
#[tauri::command]
pub fn focus_window(app: tauri::AppHandle) -> AppResult<()> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    Ok(())
}

/// Version banner for the About page.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub tauri_version: String,
    pub build_profile: String,
    pub target: String,
    pub identifier: String,
}

#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo {
        name: "YT Downloader".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        tauri_version: tauri::VERSION.to_string(),
        build_profile: if cfg!(debug_assertions) {
            "debug".into()
        } else {
            "release".into()
        },
        target: format!("{}-{}", std::env::consts::ARCH, std::env::consts::OS),
        identifier: "com.ytdownloader.desktop".into(),
    }
}
