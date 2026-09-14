//! YT Downloader — application shell.
//!
//! This module owns the window, the plugin set and the shared state. Everything with
//! real behaviour lives in the sibling modules so it can be tested without a window:
//!
//! * [`core`]      – errors, paths, logging, filesystem helpers
//! * [`models`]    – the data contract shared with the frontend
//! * [`runtime`]   – locating and verifying yt-dlp / FFmpeg
//! * [`process`]   – the single place that spawns and kills child processes
//! * [`services`]  – yt-dlp and FFmpeg argument building, parsing and error mapping
//! * [`downloader`]- the queue and the task state machine
//! * [`store`]     – settings, history and favourites on disk
//! * [`commands`]  – the IPC surface

/// Production builds must embed the frontend.
///
/// Tauri computes `dev = !custom_protocol`, so a *release* build that forgot the
/// `custom-protocol` feature would produce a binary that tries to reach the Vite dev
/// server. That failure is silent at build time and only shows up as
/// "localhost refused to connect" in the shipped folder, so it is turned into a
/// compile error instead.
#[cfg(all(dev, not(debug_assertions)))]
compile_error!(
    "release build without the `custom-protocol` feature: the application would serve \
     the dev server instead of the embedded frontend. Build with \
     `cargo build --release --features custom-protocol` (scripts/build.ps1 does this)."
);

pub mod commands;
pub mod core;
pub mod downloader;
pub mod models;
pub mod process;
pub mod runtime;
pub mod services;
pub mod store;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{Emitter, Manager, WindowEvent};

use crate::core::logging::{self, LogLevel};
use crate::core::paths;

/// Set once the user has confirmed closing from the in-app dialog.
pub struct ExitState(pub AtomicBool);

pub fn run() {
    // WebView2 keeps its browser profile beside the application data. Without this
    // the runtime would create it under %LOCALAPPDATA%, which this project never
    // does.
    if let Ok(roots) = paths::resolve_data_roots() {
        let profile = roots.root.join("webview");
        let _ = std::fs::create_dir_all(&profile);
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", profile);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ExitState(AtomicBool::new(false)))
        .setup(|app| {
            let roots = paths::resolve_data_roots().map_err(|error| error.to_string())?;
            roots.ensure().map_err(|error| error.to_string())?;

            logging::init(roots.log_file(), LogLevel::Info);
            logging::attach_app(app.handle().clone());

            log_info!(
                "app",
                "YT Downloader {} starting ({} profile) data={}",
                env!("CARGO_PKG_VERSION"),
                if cfg!(debug_assertions) { "debug" } else { "release" },
                roots.root.display()
            );

            // `cfg(dev)` is set from Tauri's `custom-protocol` feature. A binary built
            // without it serves `devUrl` instead of the embedded frontend, which looks
            // like "localhost refused to connect" in a release folder — so the source
            // of the interface is recorded explicitly at every start.
            log_info!(
                "app",
                "frontend source: {}",
                if cfg!(dev) {
                    "dev server (devUrl) — NOT a production build"
                } else {
                    "embedded assets (frontendDist)"
                }
            );

            let settings = Arc::new(
                store::SettingsStore::load(roots.clone()).map_err(|error| error.to_string())?,
            );
            let history = Arc::new(
                store::HistoryStore::load(roots.clone()).map_err(|error| error.to_string())?,
            );
            let favorites = Arc::new(
                store::FavoritesStore::load(roots.clone()).map_err(|error| error.to_string())?,
            );

            // Honour the saved log level from the very first run, not only after the
            // Settings page writes it.
            {
                let saved = settings.snapshot();
                let level = match saved.advanced.log_level.to_ascii_lowercase().as_str() {
                    "debug" => LogLevel::Debug,
                    "warn" => LogLevel::Warn,
                    "error" => LogLevel::Error,
                    _ => LogLevel::Info,
                };
                logging::set_min_level(level);
            }

            let registry = Arc::new(process::ProcessRegistry::new());
            let manager = downloader::DownloadManager::new(
                settings.clone(),
                history.clone(),
                roots.clone(),
                registry.clone(),
            );
            manager.attach_app(app.handle().clone());

            // Native title bar only when the user asked for it.
            let snapshot = settings.snapshot();
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_decorations(snapshot.appearance.native_decorations);
            }

            // Report the runtime state once at start-up so the UI can warn early.
            {
                let settings_for_probe = settings.clone();
                let registry_for_probe = registry.clone();
                let roots_for_probe = roots.clone();
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let status = runtime::inspect(
                        &settings_for_probe.snapshot(),
                        registry_for_probe,
                        &roots_for_probe,
                    )
                    .await;
                    if !status.complete {
                        log_warn!("app", "runtime incomplete: {} warning(s)", status.warnings.len());
                    }
                    let _ = handle.emit("runtime:status", status);
                });
            }

            app.manage(commands::AppState::new(
                settings, history, favorites, manager, registry, roots,
            ));

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let confirmed = app
                    .try_state::<ExitState>()
                    .map(|state| state.0.load(Ordering::SeqCst))
                    .unwrap_or(true);

                let needs_confirmation = app
                    .try_state::<commands::AppState>()
                    .map(|state| {
                        let settings = state.settings.snapshot();
                        settings.general.confirm_before_exit
                            && state.manager.active_count() > 0
                    })
                    .unwrap_or(false);

                if needs_confirmation && !confirmed {
                    api.prevent_close();
                    let _ = window.emit("app:confirm-exit", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            // media
            commands::media::validate_urls,
            commands::media::probe_url,
            commands::media::probe_playlist,
            commands::media::cancel_probe,
            commands::media::supported_link_examples,
            commands::media::data_root,
            // cookies
            commands::cookies::cookie_status,
            commands::cookies::validate_cookie_file,
            // queue
            commands::downloads::enqueue_downloads,
            commands::downloads::list_tasks,
            commands::downloads::get_task,
            commands::downloads::pause_task,
            commands::downloads::resume_task,
            commands::downloads::cancel_task,
            commands::downloads::retry_task,
            commands::downloads::retry_merge,
            commands::downloads::remove_task,
            commands::downloads::clear_finished_tasks,
            commands::downloads::queue_summary,
            // library
            commands::library::history_list,
            commands::library::history_remove,
            commands::library::history_clear,
            commands::library::favorites_list,
            commands::library::favorites_upsert,
            commands::library::favorites_remove,
            commands::library::favorites_contains,
            // settings
            commands::settings::get_settings,
            commands::settings::update_settings,
            commands::settings::reset_settings,
            commands::settings::recent_logs,
            commands::settings::clear_logs,
            commands::settings::storage_info,
            // runtime and shell
            commands::runtime::runtime_status,
            commands::runtime::open_path,
            commands::runtime::open_url,
            commands::runtime::reveal_path,
            commands::runtime::open_folder,
            commands::runtime::path_facts,
            commands::runtime::delete_file,
            commands::runtime::apply_window_appearance,
            commands::runtime::focus_window,
            commands::runtime::app_info,
            // shell helpers that need only the app handle
            confirm_exit,
        ])
        .run(tauri::generate_context!())
        .expect("error while running YT Downloader");
}

/// Called by the frontend after the user accepts the close confirmation dialog.
#[tauri::command]
fn confirm_exit(app: tauri::AppHandle) {
    if let Some(state) = app.try_state::<ExitState>() {
        state.0.store(true, Ordering::SeqCst);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.close();
    }
}
