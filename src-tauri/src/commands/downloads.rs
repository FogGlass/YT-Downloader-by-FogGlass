//! Download queue commands.
//!
//! Every one of these maps onto a real process action or a real file operation —
//! there is no command that only changes a flag shown in the UI.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::AppState;
use crate::core::error::AppResult;
use crate::models::task::{DownloadRequest, DownloadTask};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueResult {
    pub ids: Vec<String>,
    pub queued: usize,
}

/// Add one or many downloads to the queue.
#[tauri::command]
pub fn enqueue_downloads(
    state: State<'_, AppState>,
    requests: Vec<DownloadRequest>,
) -> AppResult<EnqueueResult> {
    let ids = state.manager.enqueue(requests);
    Ok(EnqueueResult {
        queued: ids.len(),
        ids,
    })
}

#[tauri::command]
pub fn list_tasks(state: State<'_, AppState>) -> Vec<DownloadTask> {
    state.manager.list()
}

#[tauri::command]
pub fn get_task(state: State<'_, AppState>, id: String) -> Option<DownloadTask> {
    state.manager.get(&id)
}

/// Stop a task, keeping partial data so it can be resumed.
#[tauri::command]
pub fn pause_task(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.manager.pause(&id)
}

#[tauri::command]
pub fn resume_task(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.manager.resume(&id)
}

#[tauri::command]
pub fn cancel_task(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.manager.cancel(&id)
}

/// Re-run a task, reusing whatever streams already finished.
#[tauri::command]
pub fn retry_task(
    state: State<'_, AppState>,
    id: String,
    from_scratch: Option<bool>,
) -> AppResult<()> {
    state.manager.retry(&id, from_scratch.unwrap_or(false))
}

/// Recover a task whose streams are complete but whose mux step failed.
#[tauri::command]
pub fn retry_merge(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.manager.retry_merge(&id)
}

#[tauri::command]
pub fn remove_task(
    state: State<'_, AppState>,
    id: String,
    delete_files: Option<bool>,
) -> AppResult<()> {
    state.manager.remove(&id, delete_files.unwrap_or(false))
}

#[tauri::command]
pub fn clear_finished_tasks(state: State<'_, AppState>, include_failed: Option<bool>) -> usize {
    state.manager.clear_finished(include_failed.unwrap_or(false))
}

/// Live counters used by the sidebar badge.
#[tauri::command]
pub fn queue_summary(state: State<'_, AppState>) -> QueueSummary {
    let tasks = state.manager.list();
    let mut summary = QueueSummary {
        total: tasks.len(),
        active: state.manager.active_count(),
        ..Default::default()
    };
    for task in &tasks {
        match task.state {
            crate::models::task::TaskState::Queued => summary.queued += 1,
            crate::models::task::TaskState::Completed => summary.completed += 1,
            crate::models::task::TaskState::Failed => summary.failed += 1,
            crate::models::task::TaskState::Paused => summary.paused += 1,
            _ => {}
        }
    }
    summary
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueSummary {
    pub total: usize,
    pub queued: usize,
    pub active: usize,
    pub completed: usize,
    pub failed: usize,
    pub paused: usize,
}
