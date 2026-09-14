//! Settings and logging commands.

use serde::Serialize;
use tauri::State;

use crate::commands::AppState;
use crate::core::error::AppResult;
use crate::core::logging::{self, LogEntry, LogLevel};
use crate::models::settings::AppSettings;
use crate::store::settings::SettingsPatch;
use crate::log_info;

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> AppSettings {
    state.settings.snapshot()
}

/// Persist a partial settings update and hand back the merged document.
#[tauri::command]
pub fn update_settings(state: State<'_, AppState>, patch: SettingsPatch) -> AppResult<AppSettings> {
    let updated = state.settings.patch(patch)?;
    // The log level is applied immediately so the next line is already filtered.
    let level = match updated.advanced.log_level.to_ascii_lowercase().as_str() {
        "debug" => LogLevel::Debug,
        "warn" => LogLevel::Warn,
        "error" => LogLevel::Error,
        _ => LogLevel::Info,
    };
    logging::set_min_level(level);
    log_info!("settings", "settings saved");
    Ok(updated)
}

/// Restore every default, keeping the download folder on the current volume.
#[tauri::command]
pub fn reset_settings(state: State<'_, AppState>) -> AppResult<AppSettings> {
    let defaults = AppSettings::default().with_defaults(&state.roots);
    let restored = state.settings.replace(defaults)?;
    log_info!("settings", "settings reset to defaults");
    Ok(restored)
}

#[tauri::command]
pub fn recent_logs(limit: Option<usize>) -> Vec<LogEntry> {
    logging::recent(limit.unwrap_or(300))
}

#[tauri::command]
pub fn clear_logs() {
    logging::clear();
}

/// Where the settings, history and log files live — shown in About.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    pub root: String,
    pub settings_file: String,
    pub history_file: String,
    pub favorites_file: String,
    pub log_file: String,
    pub temp_dir: String,
    pub cache_dir: String,
    pub download_dir: String,
    pub log_size_bytes: u64,
}

#[tauri::command]
pub fn storage_info(state: State<'_, AppState>) -> StorageInfo {
    let settings = state.settings.snapshot();
    let roots = &state.roots;
    StorageInfo {
        root: roots.root.to_string_lossy().to_string(),
        settings_file: roots.settings_file().to_string_lossy().to_string(),
        history_file: roots.history_file().to_string_lossy().to_string(),
        favorites_file: roots.favorites_file().to_string_lossy().to_string(),
        log_file: roots.log_file().to_string_lossy().to_string(),
        temp_dir: roots.temp.to_string_lossy().to_string(),
        cache_dir: roots.cache.to_string_lossy().to_string(),
        download_dir: settings
            .output_dir_or_default(roots)
            .to_string_lossy()
            .to_string(),
        log_size_bytes: crate::core::fs_util::file_size(&roots.log_file()),
    }
}
