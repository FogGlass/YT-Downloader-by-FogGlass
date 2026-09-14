//! The download manager: the only component that knows how a task progresses.
//!
//! Responsibilities
//!   * own the queue and the concurrency limit,
//!   * drive one task from queued to completed (probe → streams → mux → verify),
//!   * honour pause, resume, cancel and retry against the *real* child processes,
//!   * keep partial work so a resumed task or a retried mux never downloads twice,
//!   * publish every state change to the frontend.
//!
//! The frontend never decides what a task is doing; it renders what this module
//! reports.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

use crate::core::error::{AppError, AppResult};
use crate::core::fs_util;
use crate::core::paths::DataRoots;
use crate::models::library::{HistoryEntry, HistoryStatus};
use crate::models::media::{FormatOption, FormatOptionKind, MediaProbe};
use crate::models::settings::AppSettings;
use crate::models::task::{
    DownloadProgress, DownloadRequest, DownloadResult, DownloadTask, FormatSelection, StreamProgress,
    StreamRole, TaskError, TaskState,
};
use crate::process::{
    run_process, LineSink, ProcessRegistry, ProcessSpec, ProcessStream,
};
use crate::runtime::{self, ToolSet};
use crate::services::{ffmpeg, ytdlp};
use crate::store::{HistoryStore, SettingsStore};
use crate::{log_debug, log_info, log_warn};

use super::plan::{self, TaskPlan};

/// How often a progress event may be emitted per task.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

/// Payload of the lightweight progress event.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub id: String,
    pub progress: DownloadProgress,
}

/// Per-task state that is not part of the serialised task (paths, probe, plan).
#[derive(Default, Clone)]
struct TaskRuntime {
    probe: Option<MediaProbe>,
    plan: Option<TaskPlan>,
    pause_requested: bool,
    cancel_requested: bool,
}

pub struct DownloadManager {
    settings: Arc<SettingsStore>,
    history: Arc<HistoryStore>,
    roots: DataRoots,
    registry: Arc<ProcessRegistry>,
    tasks: Mutex<Vec<DownloadTask>>,
    runtime: Mutex<HashMap<String, TaskRuntime>>,
    /// The original request per task, so a resume keeps the URL, output folder and
    /// format selection even though the queue itself is not persisted.
    requests: Mutex<HashMap<String, DownloadRequest>>,
    app: OnceLock<AppHandle>,
    active: AtomicUsize,
    notify: Notify,
    scheduler: AtomicBool,
    last_progress: Mutex<HashMap<String, Instant>>,
}

/// Everything a running task needs, resolved once.
struct RunContext {
    id: String,
    settings: AppSettings,
    roots: DataRoots,
    tools: ToolSet,
    request: DownloadRequest,
    plan: TaskPlan,
    probe: Option<MediaProbe>,
    selection: FormatSelection,
}

impl DownloadManager {
    pub fn new(
        settings: Arc<SettingsStore>,
        history: Arc<HistoryStore>,
        roots: DataRoots,
        registry: Arc<ProcessRegistry>,
    ) -> Arc<Self> {
        Arc::new(Self {
            settings,
            history,
            roots,
            registry,
            tasks: Mutex::new(Vec::new()),
            runtime: Mutex::new(HashMap::new()),
            requests: Mutex::new(HashMap::new()),
            app: OnceLock::new(),
            active: AtomicUsize::new(0),
            notify: Notify::new(),
            scheduler: AtomicBool::new(false),
            last_progress: Mutex::new(HashMap::new()),
        })
    }

    pub fn attach_app(&self, app: AppHandle) {
        let _ = self.app.set(app);
    }

    // -----------------------------------------------------------------------
    // Queries
    // -----------------------------------------------------------------------

    pub fn list(&self) -> Vec<DownloadTask> {
        self.tasks
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    pub fn get(&self, id: &str) -> Option<DownloadTask> {
        self.tasks
            .lock()
            .ok()
            .and_then(|guard| guard.iter().find(|task| task.id == id).cloned())
    }

    pub fn active_count(&self) -> usize {
        self.active.load(Ordering::SeqCst)
    }

    // -----------------------------------------------------------------------
    // State helpers
    // -----------------------------------------------------------------------

    fn with_task<R>(&self, id: &str, mutate: impl FnOnce(&mut DownloadTask) -> R) -> Option<R> {
        let mut guard = self.tasks.lock().ok()?;
        let task = guard.iter_mut().find(|task| task.id == id)?;
        Some(mutate(task))
    }

    fn with_runtime<R>(&self, id: &str, mutate: impl FnOnce(&mut TaskRuntime) -> R) -> Option<R> {
        let mut guard = self.runtime.lock().ok()?;
        let entry = guard.entry(id.to_string()).or_default();
        Some(mutate(entry))
    }

    fn runtime_snapshot(&self, id: &str) -> TaskRuntime {
        self.runtime
            .lock()
            .ok()
            .and_then(|guard| guard.get(id).cloned())
            .unwrap_or_default()
    }

    fn emit(&self, event: &str, payload: impl serde::Serialize + Clone) {
        if let Some(app) = self.app.get() {
            if let Err(error) = app.emit(event, payload) {
                log_debug!("events", "emit {event} failed: {error}");
            }
        }
    }

    fn publish(&self, id: &str) {
        if let Some(task) = self.get(id) {
            self.emit("task:update", task);
        }
    }

    fn set_state(&self, id: &str, state: TaskState) {
        self.with_task(id, |task| {
            task.state = state;
            match state {
                TaskState::Downloading | TaskState::Merging => {
                    if task.started_at.is_none() {
                        task.started_at = Some(now());
                    }
                }
                TaskState::Completed | TaskState::Failed | TaskState::Cancelled => {
                    task.finished_at = Some(now());
                }
                _ => {}
            }
        });
        self.publish(id);
    }

    fn set_stage(&self, id: &str, stage: &str) {
        self.with_task(id, |task| task.progress.stage = stage.to_string());
        self.publish(id);
    }

    fn push_notice(&self, id: &str, notice: impl Into<String>) {
        let notice = notice.into();
        let changed = self
            .with_task(id, |task| {
                if task.notices.iter().any(|existing| existing == &notice) {
                    return false;
                }
                task.notices.push(notice);
                if task.notices.len() > 20 {
                    task.notices.remove(0);
                }
                true
            })
            .unwrap_or(false);
        if changed {
            self.publish(id);
        }
    }

    fn is_pause_requested(&self, id: &str) -> bool {
        self.runtime_snapshot(id).pause_requested
    }

    fn is_cancel_requested(&self, id: &str) -> bool {
        self.runtime_snapshot(id).cancel_requested
    }

    // -----------------------------------------------------------------------
    // Queueing
    // -----------------------------------------------------------------------

    /// Add tasks to the queue. Every request becomes one task.
    pub fn enqueue(self: &Arc<Self>, requests: Vec<DownloadRequest>) -> Vec<String> {
        let mut created = Vec::with_capacity(requests.len());

        for request in requests {
            let id = uuid::Uuid::new_v4().to_string();
            let mut task = DownloadTask::new(id.clone(), request.url.clone(), now());
            task.title = request
                .title_hint
                .clone()
                .unwrap_or_else(|| request.url.clone());
            task.thumbnail = request.thumbnail_hint.clone();
            task.uploader = request.uploader_hint.clone();
            task.duration = request.duration_hint;
            if let Some(selection) = request.selection.clone() {
                task.selection = selection;
            }

            if let Ok(mut guard) = self.tasks.lock() {
                guard.push(task);
            } else {
                continue;
            }
            if let Ok(mut guard) = self.runtime.lock() {
                guard.insert(id.clone(), TaskRuntime::default());
            }
            self.remember_request(&id, request);
            created.push(id);
        }

        for id in &created {
            self.publish(id);
        }
        log_info!("queue", "enqueued {} task(s)", created.len());
        self.schedule();
        created
    }

    // -----------------------------------------------------------------------
    // Scheduling
    // -----------------------------------------------------------------------

    /// Start the scheduler loop if it is not already running.
    pub fn schedule(self: &Arc<Self>) {
        if self.scheduler.swap(true, Ordering::SeqCst) {
            self.notify.notify_one();
            return;
        }

        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let concurrency = manager
                    .settings
                    .snapshot()
                    .downloads
                    .concurrency
                    .clamp(1, 8) as usize;

                let mut started_any = false;
                while manager.active.load(Ordering::SeqCst) < concurrency {
                    // The lock is taken and released inside `claim_next`, and the state
                    // change is published afterwards. Doing any of it while the queue
                    // mutex is held would re-enter the same non-reentrant lock.
                    let Some(id) = manager.claim_next_queued() else {
                        break;
                    };
                    manager.publish(&id);
                    manager.active.fetch_add(1, Ordering::SeqCst);
                    started_any = true;
                    let manager = manager.clone();
                    tauri::async_runtime::spawn(async move {
                        run_task(manager.clone(), id.clone()).await;
                        manager.active.fetch_sub(1, Ordering::SeqCst);
                        manager.notify.notify_one();
                    });
                }

                if !started_any && manager.active.load(Ordering::SeqCst) == 0 {
                    // Nothing running and nothing queued: idle out.
                    let pending = manager
                        .tasks
                        .lock()
                        .map(|guard| guard.iter().any(|task| task.state == TaskState::Queued))
                        .unwrap_or(false);
                    if !pending {
                        break;
                    }
                }

                let _ = tokio::time::timeout(Duration::from_millis(400), manager.notify.notified())
                    .await;
            }
            manager.scheduler.store(false, Ordering::SeqCst);
            log_debug!("queue", "scheduler idle");
        });
    }

    /// Move the oldest queued task to `Probing` and return its id.
    ///
    /// Everything that touches shared state happens inside the single lock scope; the
    /// caller publishes after this returns.
    fn claim_next_queued(&self) -> Option<String> {
        let mut guard = self.tasks.lock().ok()?;
        let task = guard
            .iter_mut()
            .find(|task| task.state == TaskState::Queued)?;
        task.state = TaskState::Probing;
        task.progress.stage = "准备中".into();
        task.started_at.get_or_insert_with(now);
        Some(task.id.clone())
    }

    // -----------------------------------------------------------------------
    // User actions
    // -----------------------------------------------------------------------

    /// Stop a running task but keep everything already downloaded.
    pub fn pause(&self, id: &str) -> AppResult<()> {
        let state = self.get(id).map(|task| task.state);
        match state {
            Some(TaskState::Queued) => {
                self.with_runtime(id, |runtime| runtime.pause_requested = true);
                self.set_state(id, TaskState::Paused);
                self.set_stage(id, "已暂停");
                Ok(())
            }
            Some(state) if state.is_active() => {
                self.with_runtime(id, |runtime| runtime.pause_requested = true);
                self.registry.cancel(id);
                log_info!("queue", "pause requested for {id}");
                Ok(())
            }
            Some(TaskState::Paused) => Ok(()),
            Some(_) => Err(AppError::message("该任务当前无法暂停")),
            None => Err(AppError::NotFound("任务不存在".into())),
        }
    }

    /// Put a paused or failed task back in the queue.
    pub fn resume(self: &Arc<Self>, id: &str) -> AppResult<()> {
        let task = self.get(id).ok_or_else(|| AppError::NotFound("任务不存在".into()))?;
        if task.state.is_active() {
            return Err(AppError::message("任务正在运行"));
        }
        if task.state == TaskState::Completed {
            return Err(AppError::message("任务已完成，请使用「重新下载」"));
        }

        self.with_runtime(id, |runtime| {
            runtime.pause_requested = false;
            runtime.cancel_requested = false;
        });
        self.with_task(id, |task| {
            task.error = None;
            task.progress.stage = "等待中".into();
        });
        self.set_state(id, TaskState::Queued);
        self.schedule();
        Ok(())
    }

    /// Stop a task and remove the partial files it created.
    pub fn cancel(self: &Arc<Self>, id: &str) -> AppResult<()> {
        let task = self.get(id).ok_or_else(|| AppError::NotFound("任务不存在".into()))?;

        self.with_runtime(id, |runtime| runtime.cancel_requested = true);

        if task.state.is_active() || self.registry.is_running(id) {
            self.registry.cancel(id);
            return Ok(());
        }

        self.cleanup_partials(&task);
        self.set_state(id, TaskState::Cancelled);
        self.set_stage(id, "已取消");
        self.record_history(id, HistoryStatus::Cancelled, None);
        Ok(())
    }

    /// Re-run a finished task. Partial streams on disk are reused.
    pub fn retry(self: &Arc<Self>, id: &str, from_scratch: bool) -> AppResult<()> {
        let task = self.get(id).ok_or_else(|| AppError::NotFound("任务不存在".into()))?;
        if task.state.is_active() {
            return Err(AppError::message("任务正在运行"));
        }

        if from_scratch {
            self.cleanup_partials(&task);
            self.with_runtime(id, |runtime| {
                runtime.plan = None;
                runtime.probe = None;
            });
        }

        self.with_runtime(id, |runtime| {
            runtime.pause_requested = false;
            runtime.cancel_requested = false;
        });
        self.with_task(id, |task| {
            task.error = None;
            task.merge_ready = false;
            task.attempts += 1;
            task.progress = DownloadProgress {
                stage: "等待中".into(),
                ..Default::default()
            };
            task.streams.clear();
            task.finished_at = None;
        });
        self.set_state(id, TaskState::Queued);
        self.schedule();
        Ok(())
    }

    /// Retry only the mux step.
    ///
    /// This is the recovery path for "both streams downloaded, FFmpeg failed": the
    /// network is never touched again.
    pub fn retry_merge(self: &Arc<Self>, id: &str) -> AppResult<()> {
        let task = self.get(id).ok_or_else(|| AppError::NotFound("任务不存在".into()))?;
        if task.state.is_active() {
            return Err(AppError::message("任务正在运行"));
        }

        let video = task
            .streams
            .iter()
            .find(|stream| stream.role == StreamRole::Video)
            .and_then(|stream| stream.path.clone())
            .map(PathBuf::from);
        let audio = task
            .streams
            .iter()
            .find(|stream| stream.role == StreamRole::Audio)
            .and_then(|stream| stream.path.clone())
            .map(PathBuf::from);

        let (Some(video), Some(audio)) = (video, audio) else {
            return Err(AppError::message(
                "没有找到已下载的视频/音频流，无法只重试合并",
            ));
        };
        if !video.exists() || !audio.exists() {
            return Err(AppError::message("分片文件已不存在，需要重新下载"));
        }

        self.with_runtime(id, |runtime| {
            runtime.pause_requested = false;
            runtime.cancel_requested = false;
        });
        self.with_task(id, |task| {
            task.error = None;
            task.notices.push("只重试合并，不再重新下载".into());
            task.progress.stage = "合并中".into();
        });
        self.set_state(id, TaskState::Queued);
        self.schedule();
        Ok(())
    }

    /// Remove a task from the queue, optionally deleting its files.
    pub fn remove(self: &Arc<Self>, id: &str, delete_files: bool) -> AppResult<()> {
        let task = self.get(id).ok_or_else(|| AppError::NotFound("任务不存在".into()))?;
        if task.state.is_active() {
            return Err(AppError::message("请先取消正在运行的任务"));
        }

        if delete_files {
            self.cleanup_partials(&task);
            if let Some(output) = &task.output {
                fs_util::remove_file_quietly(std::path::Path::new(&output.file_path));
            }
        }

        if let Ok(mut guard) = self.tasks.lock() {
            guard.retain(|task| task.id != id);
        }
        if let Ok(mut guard) = self.runtime.lock() {
            guard.remove(id);
        }
        if let Ok(mut guard) = self.last_progress.lock() {
            guard.remove(id);
        }

        self.emit("task:removed", id.to_string());
        Ok(())
    }

    /// Drop every finished task from the list.
    pub fn clear_finished(&self, include_failed: bool) -> usize {
        let removed_ids: Vec<String> = {
            let Ok(mut guard) = self.tasks.lock() else {
                return 0;
            };
            let mut removed = Vec::new();
            guard.retain(|task| {
                let drop = match task.state {
                    TaskState::Completed | TaskState::Cancelled => true,
                    TaskState::Failed => include_failed,
                    _ => false,
                };
                if drop {
                    removed.push(task.id.clone());
                }
                !drop
            });
            removed
        };

        if let Ok(mut guard) = self.runtime.lock() {
            for id in &removed_ids {
                guard.remove(id);
            }
        }
        if let Ok(mut guard) = self.requests.lock() {
            for id in &removed_ids {
                guard.remove(id);
            }
        }

        self.emit("task:cleared", removed_ids.len());
        removed_ids.len()
    }

    // -----------------------------------------------------------------------
    // Internals used by the runner
    // -----------------------------------------------------------------------

    fn remember_request(&self, id: &str, request: DownloadRequest) {
        if let Ok(mut guard) = self.requests.lock() {
            guard.insert(id.to_string(), request);
        }
    }

    fn request_for(&self, id: &str) -> Option<DownloadRequest> {
        self.requests
            .lock()
            .ok()
            .and_then(|guard| guard.get(id).cloned())
    }

    fn store_probe(&self, id: &str, probe: MediaProbe) {
        self.with_runtime(id, |runtime| runtime.probe = Some(probe.clone()));
        self.with_task(id, |task| {
            task.title = probe.title.clone();
            task.thumbnail = probe.thumbnail.clone();
            task.uploader = probe.uploader.clone();
            task.duration = probe.duration;
            task.kind = probe.kind;
        });
    }

    fn store_plan(&self, id: &str, plan: TaskPlan) {
        self.with_runtime(id, |runtime| runtime.plan = Some(plan));
    }

    fn record_stream(&self, id: &str, role: StreamRole, format_id: &str, ext: &str, path: PathBuf) {
        let size = fs_util::file_size(&path);
        self.with_task(id, |task| {
            let entry = match task.streams.iter_mut().find(|stream| stream.role == role) {
                Some(entry) => entry,
                None => {
                    task.streams.push(StreamProgress {
                        role,
                        ..Default::default()
                    });
                    task.streams.last_mut().expect("just pushed")
                }
            };
            entry.format_id = format_id.to_string();
            entry.ext = ext.to_string();
            entry.path = Some(path.to_string_lossy().to_string());
            entry.downloaded_bytes = size;
            entry.total_bytes = Some(size);
            entry.finished = true;
        });
        self.publish(id);
    }

    fn apply_progress(
        &self,
        id: &str,
        role: StreamRole,
        index: usize,
        planned: usize,
        update: &ytdlp::ProgressUpdate,
    ) {
        let progress = {
            let Ok(mut guard) = self.tasks.lock() else {
                return;
            };
            let Some(task) = guard.iter_mut().find(|task| task.id == id) else {
                return;
            };

            let entry = match task.streams.iter_mut().find(|stream| stream.role == role) {
                Some(entry) => entry,
                None => {
                    task.streams.push(StreamProgress {
                        role,
                        ..Default::default()
                    });
                    task.streams.last_mut().expect("just pushed")
                }
            };
            entry.downloaded_bytes = update.downloaded_bytes.max(0.0) as u64;
            if let Some(total) = update.total_bytes {
                if total > 0.0 {
                    entry.total_bytes = Some(total as u64);
                }
            }
            entry.speed = update.speed;
            entry.eta = update.eta;

            let stream_ratio = update
                .ratio()
                .or_else(|| {
                    entry
                        .total_bytes
                        .filter(|total| *total > 0)
                        .map(|total| entry.downloaded_bytes as f64 / total as f64)
                })
                .unwrap_or(0.0);

            let planned = planned.max(1);
            let percent = ((index as f64 + stream_ratio) / planned as f64).clamp(0.0, 1.0);

            task.progress.percent = percent;
            task.progress.downloaded_bytes = task
                .streams
                .iter()
                .map(|stream| stream.downloaded_bytes)
                .sum();
            task.progress.total_bytes = {
                let totals: Vec<u64> = task
                    .streams
                    .iter()
                    .filter_map(|stream| stream.total_bytes)
                    .collect();
                if totals.len() == task.streams.len() {
                    Some(totals.iter().sum())
                } else {
                    None
                }
            };
            task.progress.speed = update.speed;
            task.progress.eta = update.eta;
            task.progress.stage_percent = Some(stream_ratio);

            task.progress.clone()
        };

        let due = {
            let mut guard = match self.last_progress.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            let now = Instant::now();
            match guard.get(id) {
                Some(previous) if now.duration_since(*previous) < PROGRESS_INTERVAL => false,
                _ => {
                    guard.insert(id.to_string(), now);
                    true
                }
            }
        };

        if due {
            // A light payload (task id + progress) is cheap for the webview to apply;
            // the full task snapshot follows at the same throttled rate so cards that
            // show speed, size and ETA stay accurate.
            self.emit(
                "task:progress",
                ProgressEvent {
                    id: id.to_string(),
                    progress: progress.clone(),
                },
            );
            self.publish(id);
        }
    }

    fn progress_sink(self: &Arc<Self>, id: &str, role: StreamRole, index: usize, planned: usize) -> LineSink {
        let manager = self.clone();
        let id = id.to_string();
        Arc::new(move |stream, line| match stream {
            ProcessStream::Stdout => {
                if let Some(update) = ytdlp::ProgressUpdate::parse(line) {
                    manager.apply_progress(&id, role, index, planned, &update);
                } else if let Some(post) = ytdlp::PostProcessUpdate::parse(line) {
                    log_debug!(
                        "ytdlp",
                        "postprocess {} {} ({id})",
                        post.postprocessor,
                        post.status
                    );
                }
            }
            ProcessStream::Stderr => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    return;
                }
                log_debug!("ytdlp", "{trimmed}");
                if trimmed.starts_with("WARNING") {
                    manager.push_notice(&id, trimmed.trim_start_matches("WARNING:").trim());
                }
            }
        })
    }

    fn cleanup_partials(&self, task: &DownloadTask) {
        let Some(directory) = self.directory_for(task) else {
            return;
        };

        for stream in &task.streams {
            if let Some(path) = &stream.path {
                fs_util::remove_file_quietly(std::path::Path::new(path));
            }
        }

        // Remove leftover `.part`/`.ytdl` fragments for this task's base name.
        let base = task
            .output
            .as_ref()
            .and_then(|output| {
                std::path::Path::new(&output.file_name)
                    .file_stem()
                    .map(|value| value.to_string_lossy().to_string())
            })
            .unwrap_or_else(|| task.title.clone());

        for path in fs_util::files_with_prefix(&directory, &base) {
            let name = path
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_default();
            if name.ends_with(".part") || name.ends_with(".ytdl") || name.ends_with(".temp") {
                fs_util::remove_file_quietly(&path);
            }
        }
    }

    fn directory_for(&self, task: &DownloadTask) -> Option<PathBuf> {
        if let Some(plan) = self.runtime_snapshot(&task.id).plan {
            return Some(plan.directory);
        }
        if let Some(output) = &task.output {
            return Some(PathBuf::from(&output.directory));
        }
        if let Some(stream) = task.streams.iter().find_map(|stream| stream.path.as_ref()) {
            return PathBuf::from(stream).parent().map(|path| path.to_path_buf());
        }
        None
    }

    fn record_history(&self, id: &str, status: HistoryStatus, error: Option<String>) {
        let Some(task) = self.get(id) else {
            return;
        };

        let entry = HistoryEntry {
            id: uuid::Uuid::new_v4().to_string(),
            task_id: task.id.clone(),
            url: task.url.clone(),
            title: task.title.clone(),
            thumbnail: task.thumbnail.clone(),
            uploader: task.uploader.clone(),
            duration: task.duration,
            file_path: task.output.as_ref().map(|output| output.file_path.clone()),
            directory: task.output.as_ref().map(|output| output.directory.clone()),
            size_bytes: task.output.as_ref().map(|output| output.size_bytes).unwrap_or(0),
            container: task.output.as_ref().map(|output| output.container.clone()),
            status,
            selection_label: if task.selection.label.is_empty() {
                None
            } else {
                Some(ytdlp::selection_summary(&task.selection))
            },
            error,
            finished_at: now(),
            subtitle_paths: task
                .output
                .as_ref()
                .map(|output| output.subtitle_paths.clone())
                .unwrap_or_default(),
            merged_from: task
                .output
                .as_ref()
                .map(|output| output.merged_from.clone())
                .unwrap_or_default(),
        };

        if let Err(error) = self.history.add(entry) {
            log_warn!("history", "cannot record history: {error}");
        }
    }
}

fn now() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

// ---------------------------------------------------------------------------
// Task execution
// ---------------------------------------------------------------------------

async fn run_task(manager: Arc<DownloadManager>, id: String) {
    let result = execute(&manager, &id).await;

    match result {
        Ok(()) => {}
        Err(error) => {
            if manager.is_pause_requested(&id) {
                manager.set_stage(&id, "已暂停");
                manager.set_state(&id, TaskState::Paused);
                log_info!("queue", "task {id} paused");
            } else if manager.is_cancel_requested(&id) {
                if let Some(task) = manager.get(&id) {
                    manager.cleanup_partials(&task);
                }
                manager.set_stage(&id, "已取消");
                manager.set_state(&id, TaskState::Cancelled);
                manager.record_history(&id, HistoryStatus::Cancelled, None);
                log_info!("queue", "task {id} cancelled");
            } else {
                log_warn!("queue", "task {id} failed: {error}");
                manager.fail(&id, error);
            }
        }
    }
}

impl DownloadManager {
    /// Mark a task as failed, keeping the mux-recovery path available.
    fn fail(&self, id: &str, error: AppError) {
        // Failures raised inside a download keep the classification produced by
        // `ytdlp::from_outcome` (including its actionable hint); this path only covers
        // errors that never reached that point.
        let existing = self.get(id).and_then(|task| task.error.clone());
        let task_error = match existing {
            Some(previous) if previous.kind != "cancelled" => TaskError {
                command: self.get(id).and_then(|task| task.command_preview.clone()),
                ..previous
            },
            _ => match &error {
                AppError::Message(_) => TaskError {
                    summary: error.to_string(),
                    detail: None,
                    hint: None,
                    kind: "message".into(),
                    exit_code: None,
                    command: None,
                },
                _ => TaskError {
                    summary: error.to_string(),
                    detail: None,
                    hint: None,
                    kind: error.kind().to_string(),
                    exit_code: None,
                    command: self.get(id).and_then(|task| task.command_preview.clone()),
                },
            },
        };

        self.with_task(id, |task| {
            task.error = Some(task_error.clone());
            // Streams on disk + a mux failure means the task can be completed by
            // re-running FFmpeg alone.
            let has_both = task
                .streams
                .iter()
                .any(|stream| stream.role == StreamRole::Video && stream.finished)
                && task
                    .streams
                    .iter()
                    .any(|stream| stream.role == StreamRole::Audio && stream.finished);
            task.merge_ready = has_both && task.selection.needs_merge();
            if task.merge_ready {
                task.notices
                    .push("视频与音频已下载完成，可只重试合并".into());
            }
            task.progress.stage = "失败".into();
            task.finished_at = Some(now());
        });

        self.set_state(id, TaskState::Failed);
        self.record_history(
            id,
            HistoryStatus::Failed,
            Some(task_error.summary.clone()),
        );
        self.emit("task:failed", task_error);
    }
}

async fn execute(manager: &Arc<DownloadManager>, id: &str) -> AppResult<()> {
    let context = prepare(manager, id).await?;

    download_streams(manager, &context).await?;

    let result = if context.plan.needs_merge() {
        merge_streams(manager, &context).await?
    } else {
        finalize_single(manager, &context).await?
    };

    manager.with_task(id, |task| {
        task.output = Some(result.clone());
        task.error = None;
        task.merge_ready = false;
        task.progress.percent = 1.0;
        task.progress.stage = "已完成".into();
        task.progress.eta = None;
        task.progress.speed = None;
        task.finished_at = Some(now());
    });
    manager.set_state(id, TaskState::Completed);
    manager.record_history(id, HistoryStatus::Completed, None);
    manager.emit("task:completed", result.clone());

    log_info!(
        "queue",
        "task {id} completed -> {} ({} bytes)",
        result.file_path,
        result.size_bytes
    );
    Ok(())
}

/// Resolve settings, probe if needed and build the plan.
async fn prepare(manager: &Arc<DownloadManager>, id: &str) -> AppResult<RunContext> {
    let settings = manager.settings.snapshot();
    let roots = manager.roots.clone();
    let tools = runtime::resolve(&settings);

    let task = manager
        .get(id)
        .ok_or_else(|| AppError::NotFound("任务不存在".into()))?;

    let request = manager.request_for(id).unwrap_or_else(|| DownloadRequest {
        url: task.url.clone(),
        selection: Some(task.selection.clone()).filter(|selection| {
            selection.single_format_id.is_some()
                || selection.video_format_id.is_some()
                || selection.audio_format_id.is_some()
        }),
        playlist_indices: None,
        output_dir: settings.downloads.output_dir.clone().into(),
        title_hint: Some(task.title.clone()),
        thumbnail_hint: task.thumbnail.clone(),
        uploader_hint: task.uploader.clone(),
        duration_hint: task.duration,
        ignore_cookies: None,
    });

    // A per-task "no cookies" fallback overrides the saved setting for this task only.
    let mut settings = settings;
    if request.ignore_cookies == Some(true) {
        settings.cookies.mode = crate::models::settings::CookieMode::None;
    }

    let runtime_state = manager.runtime_snapshot(id);

    // Probe only when the caller did not already resolve a format.
    let mut probe = runtime_state.probe.clone();
    if probe.is_none() && request.selection.is_none() {
        manager.set_stage(id, "解析中");
        let fetched = ytdlp::probe(
            &settings,
            &roots,
            &tools,
            manager.registry.clone(),
            &request.url,
            ytdlp::is_playlist_url(&request.url),
            request.ignore_cookies.unwrap_or(false),
        )
        .await?;
        manager.store_probe(id, fetched.clone());
        probe = Some(fetched);
    }

    // The very first entry of a playlist is downloaded as its own task, so a
    // playlist probe still carries formats for the selected entry.
    let selection = match request.selection.clone() {
        Some(selection) => selection,
        None => {
            let probe_ref = probe
                .as_ref()
                .ok_or_else(|| AppError::Runtime("无法解析该链接".into()))?;
            let option = probe_ref
                .options
                .iter()
                .find(|option| option.recommended)
                .or_else(|| probe_ref.options.first())
                .ok_or_else(|| AppError::Runtime("该视频没有可用格式".into()))?;
            selection_from_option(option)
        }
    };

    let option = probe
        .as_ref()
        .and_then(|probe| probe.options.iter().find(|option| option.id == selection.id_hint()));

    let plan = match runtime_state.plan.clone() {
        Some(plan) => plan,
        None => {
            let plan = plan::build_plan(&settings, &request, probe.as_ref(), &selection, option);
            fs_util::ensure_dir(&plan.directory)?;
            manager.store_plan(id, plan.clone());
            plan
        }
    };

    manager.with_task(id, |task| {
        task.selection = selection.clone();
        if !plan.title.is_empty() {
            task.title = plan.title.clone();
        }
    });

    Ok(RunContext {
        id: id.to_string(),
        settings,
        roots,
        tools,
        request,
        plan,
        probe,
        selection,
    })
}

fn selection_from_option(option: &FormatOption) -> FormatSelection {
    let mode = if option.kind == FormatOptionKind::VideoWithAudio {
        "video+audio"
    } else {
        "single"
    };

    FormatSelection {
        kind: format!("{:?}", option.kind),
        label: option.label.clone(),
        container: option.container.clone(),
        video_format_id: option.video_format_id.clone(),
        audio_format_id: option.audio_format_id.clone(),
        single_format_id: option.single_format_id.clone(),
        height: option.height,
        fps: option.fps,
        video_codec: option.video_codec.clone(),
        audio_codec: option.audio_codec.clone(),
        hdr: option.hdr,
        size_bytes: option.size_bytes,
        mode: mode.into(),
    }
}

impl FormatSelection {
    /// Identifier used to match a selection back to its option row.
    fn id_hint(&self) -> String {
        match (&self.video_format_id, &self.audio_format_id, &self.single_format_id) {
            (Some(video), Some(audio), _) => format!("{video}+{audio}"),
            (Some(video), None, _) => video.clone(),
            (_, _, Some(single)) => single.clone(),
            _ => String::new(),
        }
    }
}

/// Download every stream of the plan, skipping ones already on disk.
async fn download_streams(manager: &Arc<DownloadManager>, context: &RunContext) -> AppResult<()> {
    let planned = context.plan.streams.len().max(1);

    for (index, stream) in context.plan.streams.iter().enumerate() {
        if manager.is_pause_requested(&context.id) || manager.is_cancel_requested(&context.id) {
            return Err(AppError::message("已中断"));
        }

        let stem = stream.file_stem();
        if let Some(existing) = plan::find_stream_file(&context.plan.directory, &stem) {
            log_info!(
                "download",
                "reusing completed stream {} for {}",
                existing.display(),
                context.id
            );
            manager.push_notice(&context.id, "复用已下载的分片");
            manager.record_stream(
                &context.id,
                stream.role,
                &stream.format_id,
                &stream.ext_hint,
                existing,
            );
            continue;
        }

        manager.set_state(&context.id, TaskState::Downloading);
        manager.set_stage(
            &context.id,
            &format!("下载中 {}/{}", index + 1, planned),
        );

        let spec = ytdlp::StreamSpec {
            role: stream.role,
            format_id: stream.format_id.clone(),
            output_prefix: stream.prefix.to_string_lossy().to_string(),
        };

        let mut attempt = 0usize;
        loop {
            let mut spec = spec.clone();
            if attempt > 0 {
                // The retry restarts the file: resuming bytes that belong to the
                // abandoned format would mix two encodings in one file.
                spec.format_id = ytdlp::fallback_format_expression(stream.role, context.selection.height);
            }

            let mut arguments = ytdlp::stream_args(
                &context.settings,
                &context.roots,
                &context.tools,
                &spec,
                &context.request.url,
                context.plan.merge.is_none(),
            );
            if attempt > 0 {
                arguments.push("--no-continue".into());
            }

            let process = runtime::yt_dlp_spec(&context.tools, arguments, "yt-dlp download");
            let preview = process.preview.clone();
            manager.with_task(&context.id, |task| {
                task.command_preview = Some(preview.clone());
            });

            let sink = manager.progress_sink(&context.id, stream.role, index, planned);
            let outcome = run_process(
                process,
                manager.registry.clone(),
                context.id.clone(),
                sink,
            )
            .await?;

            if outcome.cancelled {
                return Err(AppError::message("已中断"));
            }
            if outcome.success() {
                break;
            }

            let mut error = ytdlp::from_outcome(&outcome);

            // A format id reported by the probe can be gone by the time the download
            // starts. One retry with an equivalent selector is worth more than a
            // failure the user cannot act on; anything else fails as before.
            if attempt == 0 && error.kind == ytdlp::FailureKind::Format.as_str() {
                attempt += 1;
                log_warn!("download", "format {} unavailable, retrying with a selector", spec.format_id);
                manager.push_notice(&context.id, "所选格式已失效，改用同等质量的可用格式重试");
                continue;
            }

            error.command = Some(preview);
            manager.with_task(&context.id, |task| task.error = Some(error.clone()));
            return Err(AppError::Process(format!(
                "{}：{}",
                error.summary,
                error.detail.unwrap_or_default()
            )));
        };

        let file = plan::find_stream_file(&context.plan.directory, &stem).ok_or_else(|| {
            AppError::Process("下载进程已结束，但没有找到输出文件".into())
        })?;

        manager.record_stream(
            &context.id,
            stream.role,
            &stream.format_id,
            &file
                .extension()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| stream.ext_hint.clone()),
            file,
        );
    }

    Ok(())
}

/// Mux the two streams, embed metadata, then verify the result with ffprobe.
async fn merge_streams(
    manager: &Arc<DownloadManager>,
    context: &RunContext,
) -> AppResult<DownloadResult> {
    let merge = context
        .plan
        .merge
        .clone()
        .ok_or_else(|| AppError::Runtime("缺少合并配置".into()))?;

    let video = plan::find_stream_file(
        &context.plan.directory,
        &context
            .plan
            .stream(StreamRole::Video)
            .map(|stream| stream.file_stem())
            .unwrap_or_else(|| context.plan.base_name.clone()),
    )
    .ok_or_else(|| AppError::Process("缺少视频流文件".into()))?;
    let audio = plan::find_stream_file(
        &context.plan.directory,
        &context
            .plan
            .stream(StreamRole::Audio)
            .map(|stream| stream.file_stem())
            .unwrap_or_else(|| format!("{}.audio", context.plan.base_name)),
    )
    .ok_or_else(|| AppError::Process("缺少音频流文件".into()))?;

    let ffmpeg = context
        .tools
        .ffmpeg
        .clone()
        .ok_or_else(|| AppError::Runtime("运行库中缺少 ffmpeg.exe".into()))?;

    manager.set_state(&context.id, TaskState::Merging);
    manager.set_stage(&context.id, "合并中");
    manager.with_task(&context.id, |task| task.progress.percent = 1.0);

    let output = context
        .plan
        .final_path
        .clone()
        .unwrap_or_else(|| context.plan.directory.join(format!("{}.{}", context.plan.base_name, merge.container)));

    // Cover art has to exist as a real image file before it can be attached.
    let thumbnail = if merge.embed_thumbnail {
        plan::find_sidecar(&context.plan.directory, &context.plan.base_name, &["jpg", "jpeg", "png", "webp"])
    } else {
        None
    };

    let tags = build_tags(context);
    let chapters = context
        .probe
        .as_ref()
        .map(|probe| probe.chapters.clone())
        .unwrap_or_default();

    let metadata_file = if (merge.embed_metadata && !tags.is_empty()) || (merge.embed_chapters && !chapters.is_empty())
    {
        let path = context
            .roots
            .temp
            .join(format!("{}.ffmetadata", context.plan.base_name));
        ffmpeg::write_metadata_file(&path, &tags, if merge.embed_chapters { &chapters } else { &[] })?;
        Some(path)
    } else {
        None
    };

    let plan_for_ffmpeg = ffmpeg::MergePlan {
        video: video.clone(),
        audio: audio.clone(),
        output: output.clone(),
        container: merge.container.clone(),
        thumbnail,
        metadata_file: metadata_file.clone(),
        tags: tags.clone(),
        chapters: chapters.clone(),
        duration: context.probe.as_ref().and_then(|probe| probe.duration),
    };

    let arguments = ffmpeg::merge_args(&context.settings, &context.tools, &plan_for_ffmpeg);
    let process = ProcessSpec::new(ffmpeg, arguments, "ffmpeg merge").with_timeout(6 * 3600);
    let preview = process.preview.clone();
    manager.with_task(&context.id, |task| {
        task.command_preview = Some(preview.clone());
    });

    let duration = plan_for_ffmpeg.duration;
    let sink: LineSink = {
        let manager = manager.clone();
        let id = context.id.clone();
        Arc::new(move |stream, line| {
            if stream != ProcessStream::Stdout {
                log_debug!("ffmpeg", "{line}");
                return;
            }
            if let Some(progress) = ffmpeg::MergeProgress::parse(line) {
                if let Some(ratio) = progress.ratio(duration) {
                    manager.with_task(&id, |task| {
                        task.progress.percent = ratio;
                        task.progress.stage_percent = Some(ratio);
                    });
                    manager.emit(
                        "task:progress",
                        ProgressEvent {
                            id: id.clone(),
                            progress: DownloadProgress {
                                percent: ratio,
                                stage: "合并中".into(),
                                stage_percent: Some(ratio),
                                ..Default::default()
                            },
                        },
                    );
                }
            }
        })
    };

    let outcome = run_process(
        process,
        manager.registry.clone(),
        context.id.clone(),
        sink,
    )
    .await?;

    if outcome.cancelled {
        return Err(AppError::message("已中断"));
    }
    if !outcome.success() {
        return Err(AppError::Process(format!(
            "合并失败：{}",
            outcome
                .stderr_tail
                .last()
                .cloned()
                .unwrap_or_else(|| format!("ffmpeg 退出码 {:?}", outcome.code))
        )));
    }

    // Verify the muxed file really carries both streams before declaring success.
    verify_output(manager, context, &output).await?;

    if !context.settings.downloads.keep_streams {
        fs_util::remove_file_quietly(&video);
        fs_util::remove_file_quietly(&audio);
    }
    if let Some(metadata_file) = metadata_file {
        fs_util::remove_file_quietly(&metadata_file);
    }

    let subtitles = plan::find_subtitles(&context.plan.directory, &context.plan.base_name);
    let thumbnail_path = plan::find_sidecar(
        &context.plan.directory,
        &context.plan.base_name,
        &["jpg", "jpeg", "png", "webp"],
    );

    Ok(DownloadResult {
        file_path: output.to_string_lossy().to_string(),
        file_name: output
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default(),
        directory: context.plan.directory.to_string_lossy().to_string(),
        size_bytes: fs_util::file_size(&output),
        container: merge.container,
        duration_seconds: context.probe.as_ref().and_then(|probe| probe.duration),
        thumbnail_path: thumbnail_path.map(|path| path.to_string_lossy().to_string()),
        subtitle_paths: subtitles
            .into_iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect(),
        merged_from: vec![
            context.selection.video_format_id.clone().unwrap_or_default(),
            context.selection.audio_format_id.clone().unwrap_or_default(),
        ],
    })
}

async fn verify_output(
    manager: &Arc<DownloadManager>,
    context: &RunContext,
    output: &std::path::Path,
) -> AppResult<()> {
    let Some(ffprobe) = context.tools.ffprobe.clone() else {
        log_warn!("ffmpeg", "ffprobe missing, skipping output verification");
        return Ok(());
    };

    let spec = ProcessSpec::new(
        ffprobe,
        ffmpeg::ffprobe_args(output),
        "ffprobe verify",
    )
    .with_timeout(120);

    let collected: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let sink: LineSink = {
        let collected = collected.clone();
        Arc::new(move |stream, line| {
            if stream == ProcessStream::Stdout {
                if let Ok(mut guard) = collected.lock() {
                    guard.push(line.to_string());
                }
            }
        })
    };

    let outcome = run_process(
        spec,
        manager.registry.clone(),
        format!("verify:{}", context.id),
        sink,
    )
    .await?;

    if !outcome.success() {
        return Err(AppError::Process("无法校验合并结果".into()));
    }

    let payload = collected
        .lock()
        .map(|guard| guard.join("\n"))
        .unwrap_or_default();
    let facts = ffmpeg::parse_ffprobe(&payload)?;
    ffmpeg::verify_facts(&facts)
}

/// Finalise a muxed-format download: locate the produced file and its sidecars.
async fn finalize_single(
    manager: &Arc<DownloadManager>,
    context: &RunContext,
) -> AppResult<DownloadResult> {
    let stream = context
        .plan
        .streams
        .first()
        .ok_or_else(|| AppError::Runtime("任务缺少下载流".into()))?;

    manager.set_stage(&context.id, "整理文件");

    let file = plan::find_stream_file(&context.plan.directory, &stream.file_stem())
        .ok_or_else(|| AppError::Process("下载完成但没有找到文件".into()))?;

    let subtitles = plan::find_subtitles(&context.plan.directory, &context.plan.base_name);
    let thumbnail_path = plan::find_sidecar(
        &context.plan.directory,
        &context.plan.base_name,
        &["jpg", "jpeg", "png", "webp"],
    );

    let container = file
        .extension()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| context.selection.container.clone());

    Ok(DownloadResult {
        file_path: file.to_string_lossy().to_string(),
        file_name: file
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default(),
        directory: context.plan.directory.to_string_lossy().to_string(),
        size_bytes: fs_util::file_size(&file),
        container,
        duration_seconds: context.probe.as_ref().and_then(|probe| probe.duration),
        thumbnail_path: thumbnail_path.map(|path| path.to_string_lossy().to_string()),
        subtitle_paths: subtitles
            .into_iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect(),
        merged_from: Vec::new(),
    })
}

fn build_tags(context: &RunContext) -> Vec<(String, String)> {
    let mut tags: Vec<(String, String)> = Vec::new();
    let Some(probe) = context.probe.as_ref() else {
        return tags;
    };

    if !probe.title.is_empty() {
        tags.push(("title".into(), probe.title.clone()));
    }
    if let Some(uploader) = &probe.uploader {
        tags.push(("artist".into(), uploader.clone()));
        tags.push(("album_artist".into(), uploader.clone()));
    }
    if let Some(date) = &probe.upload_date {
        tags.push(("date".into(), date.clone()));
    }
    tags.push(("comment".into(), probe.webpage_url.clone()));
    if let Some(description) = probe.description.as_ref().filter(|text| !text.is_empty()) {
        tags.push(("description".into(), description.chars().take(1800).collect()));
    }

    tags
}

#[cfg(test)]
mod tests {
    use super::*;

    fn option() -> FormatOption {
        FormatOption {
            id: "399+251".into(),
            kind: FormatOptionKind::VideoWithAudio,
            label: "1080p".into(),
            detail: "AV1 · Opus".into(),
            height: Some(1080),
            width: Some(1920),
            fps: Some(30.0),
            video_codec: Some("AV1".into()),
            audio_codec: Some("Opus".into()),
            container: "webm".into(),
            hdr: false,
            dynamic_range: None,
            video_format_id: Some("399".into()),
            audio_format_id: Some("251".into()),
            single_format_id: None,
            bitrate_mbps: Some(2.7),
            size_bytes: Some(80_000_000),
            audio_bitrate: Some(130.0),
            recommended: true,
            available: true,
            note: None,
        }
    }

    #[test]
    fn selections_are_derived_from_option_rows() {
        let selection = selection_from_option(&option());
        assert_eq!(selection.mode, "video+audio");
        assert!(selection.needs_merge());
        assert_eq!(selection.video_format_id.as_deref(), Some("399"));
        assert_eq!(selection.audio_format_id.as_deref(), Some("251"));
        assert_eq!(selection.id_hint(), "399+251");
    }

    #[test]
    fn muxed_rows_produce_single_mode() {
        let mut row = option();
        row.kind = FormatOptionKind::Progressive;
        row.single_format_id = Some("18".into());
        row.video_format_id = None;
        row.audio_format_id = None;
        let selection = selection_from_option(&row);
        assert_eq!(selection.mode, "single");
        assert!(!selection.needs_merge());
        assert_eq!(selection.id_hint(), "18");
    }

    #[test]
    fn progress_lines_drive_a_monotonic_percentage() {
        // Stream 1 of 2: half done → 25%.
        let update = ytdlp::ProgressUpdate::parse("YTPROG|downloading|50|100|NA|NA|NA|NA|NA").unwrap();
        let ratio = update.ratio().unwrap();
        let percent = ((0.0 + ratio) / 2.0).clamp(0.0, 1.0);
        assert!((percent - 0.25).abs() < f64::EPSILON);

        // Stream 2 of 2: half done → 75%.
        let percent = ((1.0 + ratio) / 2.0).clamp(0.0, 1.0);
        assert!((percent - 0.75).abs() < f64::EPSILON);
    }
}
