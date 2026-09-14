//! Application logger.
//!
//! Every interesting backend decision is journalled here: to a rolling in-memory
//! ring buffer (what Expert Mode shows), to a file under `<data>/logs`, and — when
//! a window is attached — to the frontend as an event.

use std::collections::VecDeque;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use chrono::Local;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

const RING_CAPACITY: usize = 600;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    fn as_str(self) -> &'static str {
        match self {
            Self::Debug => "DEBUG",
            Self::Info => "INFO",
            Self::Warn => "WARN",
            Self::Error => "ERROR",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct LogEntry {
    pub at: String,
    pub level: LogLevel,
    pub scope: String,
    pub message: String,
}

struct LoggerState {
    entries: VecDeque<LogEntry>,
    file: Option<PathBuf>,
    min_level: LogLevel,
    app: Option<AppHandle>,
}

static LOGGER: OnceLock<Mutex<LoggerState>> = OnceLock::new();

fn state() -> &'static Mutex<LoggerState> {
    LOGGER.get_or_init(|| {
        Mutex::new(LoggerState {
            entries: VecDeque::with_capacity(RING_CAPACITY),
            file: None,
            min_level: LogLevel::Info,
            app: None,
        })
    })
}

pub fn init(file: PathBuf, min_level: LogLevel) {
    let mut guard = match state().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    guard.file = Some(file);
    guard.min_level = min_level;
}

pub fn attach_app(app: AppHandle) {
    let mut guard = match state().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    guard.app = Some(app);
}

pub fn set_min_level(level: LogLevel) {
    let mut guard = match state().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    guard.min_level = level;
}

pub fn recent(limit: usize) -> Vec<LogEntry> {
    let guard = match state().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    guard
        .entries
        .iter()
        .rev()
        .take(limit)
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

pub fn clear() {
    let mut guard = match state().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    guard.entries.clear();
}

pub fn log(level: LogLevel, scope: &str, message: impl Into<String>) {
    let message = message.into();
    let entry = LogEntry {
        at: Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string(),
        level,
        scope: scope.to_string(),
        message,
    };

    let mut guard = match state().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };

    let enabled = matches!(
        (guard.min_level, entry.level),
        (LogLevel::Debug, _)
            | (LogLevel::Info, LogLevel::Info | LogLevel::Warn | LogLevel::Error)
            | (LogLevel::Warn, LogLevel::Warn | LogLevel::Error)
            | (LogLevel::Error, LogLevel::Error)
    );

    if !enabled {
        return;
    }

    if let Some(path) = guard.file.clone() {
        if let Ok(mut handle) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(
                handle,
                "{} [{}] {} {}",
                entry.at,
                entry.level.as_str(),
                entry.scope,
                entry.message
            );
        }
    }

    if guard.entries.len() >= RING_CAPACITY {
        guard.entries.pop_front();
    }
    let app = guard.app.clone();
    guard.entries.push_back(entry.clone());
    drop(guard);

    if let Some(app) = app {
        let _ = app.emit("app:log", &entry);
    }
}

#[macro_export]
macro_rules! log_info {
    ($scope:expr, $($arg:tt)*) => {
        $crate::core::logging::log($crate::core::logging::LogLevel::Info, $scope, format!($($arg)*))
    };
}

#[macro_export]
macro_rules! log_warn {
    ($scope:expr, $($arg:tt)*) => {
        $crate::core::logging::log($crate::core::logging::LogLevel::Warn, $scope, format!($($arg)*))
    };
}

#[macro_export]
macro_rules! log_error {
    ($scope:expr, $($arg:tt)*) => {
        $crate::core::logging::log($crate::core::logging::LogLevel::Error, $scope, format!($($arg)*))
    };
}

#[macro_export]
macro_rules! log_debug {
    ($scope:expr, $($arg:tt)*) => {
        $crate::core::logging::log($crate::core::logging::LogLevel::Debug, $scope, format!($($arg)*))
    };
}
