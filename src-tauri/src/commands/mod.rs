//! The complete IPC surface exposed to the frontend.
//!
//! Components never talk to a service directly: they call one typed function in
//! `src/api`, which calls exactly one command here.

pub mod cookies;
pub mod downloads;
pub mod library;
pub mod media;
pub mod runtime;
pub mod settings;

use std::sync::Arc;

use crate::core::paths::DataRoots;
use crate::downloader::DownloadManager;
use crate::process::ProcessRegistry;
use crate::store::{FavoritesStore, HistoryStore, SettingsStore};

/// Shared application state handed to every command through `tauri::State`.
pub struct AppState {
    pub settings: Arc<SettingsStore>,
    pub history: Arc<HistoryStore>,
    pub favorites: Arc<FavoritesStore>,
    pub manager: Arc<DownloadManager>,
    pub registry: Arc<ProcessRegistry>,
    pub roots: DataRoots,
}

impl AppState {
    pub fn new(
        settings: Arc<SettingsStore>,
        history: Arc<HistoryStore>,
        favorites: Arc<FavoritesStore>,
        manager: Arc<DownloadManager>,
        registry: Arc<ProcessRegistry>,
        roots: DataRoots,
    ) -> Self {
        Self {
            settings,
            history,
            favorites,
            manager,
            registry,
            roots,
        }
    }
}
