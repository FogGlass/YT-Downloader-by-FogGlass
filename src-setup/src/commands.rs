//! The IPC surface of the installer.

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::install::{self, InstallOptions};
use crate::payload::Payload;
use crate::platform;
use crate::uninstall::{self, UninstallOptions};
use crate::{SetupError, SetupState};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirCheck {
    pub path: String,
    pub writable: bool,
    pub exists: bool,
    pub free_bytes: Option<u64>,
    pub sufficient_space: bool,
    pub message: Option<String>,
}

/// Everything the window needs before it draws anything.
#[tauri::command]
pub fn setup_context(state: State<'_, Arc<SetupState>>) -> crate::SetupContext {
    state
        .context
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_else(|poisoned| poisoned.into_inner().clone())
}

/// Native folder picker, returning `null` when the user cancels.
#[tauri::command]
pub async fn setup_pick_directory(
    app: AppHandle,
    current: String,
) -> Result<Option<String>, SetupError> {
    let (sender, receiver) = std::sync::mpsc::channel();
    let mut builder = app.dialog().file().set_title("选择安装目录");
    if !current.trim().is_empty() {
        builder = builder.set_directory(current.trim());
    }
    builder.pick_folder(move |selection| {
        let _ = sender.send(selection);
    });

    let picked = tauri::async_runtime::spawn_blocking(move || receiver.recv().ok().flatten())
        .await
        .unwrap_or(None);

    Ok(picked.map(|path| path.to_string()))
}

/// Validate a candidate installation directory: writable, and large enough.
#[tauri::command]
pub fn setup_check_dir(state: State<'_, Arc<SetupState>>, path: String) -> DirCheck {
    let trimmed = path.trim().to_string();
    let target = PathBuf::from(&trimmed);

    let required = state
        .context
        .lock()
        .map(|guard| guard.extracted_bytes)
        .unwrap_or(0);

    if trimmed.is_empty() {
        return DirCheck {
            path: trimmed,
            writable: false,
            exists: false,
            free_bytes: None,
            sufficient_space: false,
            message: Some("请选择安装目录。".into()),
        };
    }

    let guard = install::validate_target(&target);
    let exists = target.exists();
    let writable = guard.is_ok() && platform::is_writable(&target);
    let free = platform::free_space(&target);
    // Leave headroom so the extraction can never fill the volume.
    let needed = required + 64 * 1024 * 1024;
    let sufficient = free.map(|bytes| bytes >= needed).unwrap_or(true);

    let message = match (&guard, writable, sufficient) {
        (Err(error), _, _) => Some(error.to_string()),
        (_, false, _) => Some("该目录不可写，请选择其他位置或以管理员身份运行。".into()),
        (_, _, false) => Some(format!(
            "可用空间不足：需要约 {}。",
            human(needed)
        )),
        _ => None,
    };

    DirCheck {
        path: trimmed,
        writable,
        exists,
        free_bytes: free,
        sufficient_space: sufficient,
        message,
    }
}

/// Begin installation. Progress arrives through `setup:progress` events.
#[tauri::command]
pub async fn setup_start_install(
    app: AppHandle,
    state: State<'_, Arc<SetupState>>,
    options: InstallOptions,
) -> Result<(), SetupError> {
    let state = state.inner().clone();
    let handle = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        // A fresh run clears any previous cancellation.
        state.cancel.store(false, Ordering::SeqCst);
        let _ = install::run_install(handle, state, options);
    });

    Ok(())
}

/// Begin uninstallation.
#[tauri::command]
pub async fn setup_start_uninstall(
    app: AppHandle,
    state: State<'_, Arc<SetupState>>,
    options: UninstallOptions,
) -> Result<(), SetupError> {
    let state = state.inner().clone();
    let handle = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        state.cancel.store(false, Ordering::SeqCst);
        let _ = uninstall::run_uninstall(handle, state, options);
    });

    Ok(())
}

/// Abort a running install/uninstall. Extraction stops between chunks and the
/// installer rolls back what it already wrote.
#[tauri::command]
pub fn setup_cancel(state: State<'_, Arc<SetupState>>) {
    state.cancel.store(true, Ordering::SeqCst);
}

/// Launch the application that was just installed.
#[tauri::command]
pub fn setup_launch_app(state: State<'_, Arc<SetupState>>) -> Result<(), SetupError> {
    let dir = state
        .context
        .lock()
        .map(|guard| guard.install_dir.clone())
        .unwrap_or(None)
        .map(PathBuf::from)
        .or_else(|| platform::read_install_location())
        .ok_or_else(|| SetupError::Message("找不到安装目录。".into()))?;

    platform::launch_detached(&dir.join(platform::APP_EXE_NAME), &[], &dir)
}

#[tauri::command]
pub fn setup_open_path(path: String) -> Result<(), SetupError> {
    platform::open_in_explorer(Path::new(&path))
}

/// Close the installer window.
#[tauri::command]
pub fn setup_close(app: AppHandle) {
    if let Some(window) = app.get_webview_window("setup") {
        let _ = window.close();
    }
}

/// Reported by the About-style diagnostics if ever needed.
#[tauri::command]
pub fn setup_payload_summary() -> Result<PayloadSummary, SetupError> {
    let payload = Payload::open_self()?;
    Ok(PayloadSummary {
        files: payload.file_count(),
        compressed_bytes: payload.compressed_bytes,
        extracted_bytes: payload.extracted_bytes,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadSummary {
    pub files: usize,
    pub compressed_bytes: u64,
    pub extracted_bytes: u64,
}

fn human(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{} {}", bytes, UNITS[0])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}
