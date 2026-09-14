//! History and favourites commands.

use tauri::State;

use crate::commands::AppState;
use crate::core::error::AppResult;
use crate::models::library::{FavoriteEntry, HistoryEntry};

#[tauri::command]
pub fn history_list(state: State<'_, AppState>, limit: Option<usize>) -> Vec<HistoryEntry> {
    state.history.list(limit)
}

#[tauri::command]
pub fn history_remove(state: State<'_, AppState>, id: String) -> AppResult<bool> {
    state.history.remove(&id)
}

/// Clear history. `only_failed` keeps successful downloads.
#[tauri::command]
pub fn history_clear(state: State<'_, AppState>, only_failed: Option<bool>) -> AppResult<usize> {
    state.history.clear(only_failed.unwrap_or(false))
}

#[tauri::command]
pub fn favorites_list(state: State<'_, AppState>) -> Vec<FavoriteEntry> {
    state.favorites.list()
}

/// Star (or re-star) a link. Keyed by URL, so this is idempotent.
#[tauri::command]
pub fn favorites_upsert(state: State<'_, AppState>, entry: FavoriteEntry) -> AppResult<Vec<FavoriteEntry>> {
    state.favorites.upsert(entry)
}

#[tauri::command]
pub fn favorites_remove(state: State<'_, AppState>, id: String) -> AppResult<Vec<FavoriteEntry>> {
    state.favorites.remove(&id)
}

#[tauri::command]
pub fn favorites_contains(state: State<'_, AppState>, url: String) -> bool {
    state.favorites.contains(&url)
}
