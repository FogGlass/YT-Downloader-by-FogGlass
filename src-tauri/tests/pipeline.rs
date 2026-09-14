//! End-to-end pipeline tests driven through the real [`DownloadManager`].
//!
//! These are the tests that answer "does it actually download?" — they enqueue a real
//! task, let the backend probe, download both streams, mux them with FFmpeg, verify
//! the result with ffprobe and record history, exactly as the application does.
//!
//! They require network access, so they only run with `YTD_LIVE_TESTS=1`:
//!
//! ```powershell
//! $env:YTD_LIVE_TESTS='1'; cargo test --test pipeline -- --test-threads=1
//! ```

use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use yt_downloader_lib::core::paths::DataRoots;
use yt_downloader_lib::downloader::DownloadManager;
use yt_downloader_lib::models::media::{FormatOption, FormatOptionKind};
use yt_downloader_lib::models::settings::AppSettings;
use yt_downloader_lib::models::task::{
    DownloadRequest, DownloadTask, FormatSelection, TaskState,
};
use yt_downloader_lib::process::ProcessRegistry;
use yt_downloader_lib::runtime;
use yt_downloader_lib::services::{ffmpeg, ytdlp};
use yt_downloader_lib::store::{HistoryStore, SettingsStore};

/// Creative Commons test video published by the Blender Foundation.
const TEST_URL: &str = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";

fn live() -> bool {
    std::env::var("YTD_LIVE_TESTS").as_deref() == Ok("1")
}

/// One process-wide runtime.
///
/// The download manager schedules work on Tauri's global async runtime, and Tauri's
/// global can only be pointed at a runtime once. Using a `#[tokio::test]` runtime per
/// test would leave the global holding a handle to a dropped runtime as soon as the
/// first test finished, so the tests share this one instead.
fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .enable_all()
            .build()
            .expect("build test runtime")
    })
}

fn block_on<F: Future>(future: F) -> F::Output {
    // Install the shared runtime as Tauri's global runtime exactly once. Calling
    // `tauri::async_runtime::spawn` without this makes Tauri construct its own default
    // runtime lazily — from inside this `block_on`, which deadlocks. `set` panics when
    // a runtime is already installed, hence the guard.
    static INSTALL: std::sync::Once = std::sync::Once::new();
    INSTALL.call_once(|| tauri::async_runtime::set(runtime().handle().clone()));
    runtime().block_on(future)
}

fn scratch_roots(name: &str) -> DataRoots {
    let root = std::env::temp_dir().join(format!("ytd-pipeline-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let roots = DataRoots {
        config: root.join("config"),
        history: root.join("history"),
        favorites: root.join("favorites"),
        logs: root.join("logs"),
        cache: root.join("cache"),
        temp: root.join("temp"),
        downloads: root.join("downloads"),
        root,
    };
    roots.ensure().expect("create data roots");
    roots
}

/// Settings tuned for a small, deterministic download.
fn test_settings(roots: &DataRoots) -> AppSettings {
    let mut settings = AppSettings::default().with_defaults(roots);
    // NOTE: `limits.download_sections` is deliberately NOT used here. yt-dlp
    // implements section downloads by handing the media URL to FFmpeg, and FFmpeg's
    // HTTPS stack (schannel) is blocked in this verification environment while
    // yt-dlp's own downloader is not. Keeping the test on yt-dlp's native downloader
    // exercises the real pipeline — probe → stream → mux → verify — without depending
    // on FFmpeg being able to reach the network.
    settings.limits.download_sections = String::new();
    settings.general.notify_on_complete = false;
    settings.downloads.embed_thumbnail = true;
    settings.downloads.embed_metadata = true;
    settings.downloads.keep_streams = false;
    settings
}

async fn build_manager(
    roots: DataRoots,
    settings: AppSettings,
) -> (Arc<DownloadManager>, Arc<HistoryStore>) {
    // NOTE: `tauri::async_runtime::set` is deliberately NOT called. It panics when the
    // runtime has already been initialised, and `tauri::async_runtime::spawn` already
    // creates (and keeps) a default runtime on first use — which is exactly what the
    // manager's scheduler needs. The test bodies run on their own runtime below.
    eprintln!("    · building stores");

    let settings_file = roots.settings_file();
    std::fs::write(
        &settings_file,
        serde_json::to_string_pretty(&settings).unwrap(),
    )
    .expect("write settings");

    let settings = Arc::new(SettingsStore::load(roots.clone()).expect("settings store"));
    let history = Arc::new(HistoryStore::load(roots.clone()).expect("history store"));
    let registry = Arc::new(ProcessRegistry::new());

    let manager = DownloadManager::new(settings, history.clone(), roots.clone(), registry);
    (manager, history)
}

/// Wait until `predicate` holds, or fail after `timeout`.
async fn wait_for<T>(
    timeout: Duration,
    mut probe: impl FnMut() -> Option<T>,
    description: &str,
) -> T {
    let started = Instant::now();
    let mut last_report = Instant::now();
    loop {
        if let Some(value) = probe() {
            return value;
        }
        if started.elapsed() > timeout {
            panic!("timed out after {timeout:?} waiting for {description}");
        }
        // Progress breadcrumbs make a stuck run diagnosable from the log.
        if last_report.elapsed() > Duration::from_secs(20) {
            eprintln!("  … still waiting for {description} ({:?})", started.elapsed());
            last_report = Instant::now();
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// Probe the test video and pick the *smallest* video+audio pair, so the live test
/// downloads as little as possible while still needing a mux step.
async fn smallest_pair(roots: &DataRoots) -> (FormatSelection, Option<FormatOption>) {
    eprintln!("    · probing {TEST_URL}");
    let settings = test_settings(roots);
    let tools = runtime::resolve(&settings);
    let probe = ytdlp::probe(
        &settings,
        roots,
        &tools,
        Arc::new(ProcessRegistry::new()),
        TEST_URL,
        false,
        false,
    )
    .await
    .expect("probe test video");
    eprintln!("    · probe returned {} options", probe.options.len());

    // Prefer the smallest split pair; fall back to the smallest muxed file. Size is
    // used when known, otherwise the lowest resolution wins.
    let by_size = |option: &&FormatOption| {
        option
            .size_bytes
            .unwrap_or(u64::MAX)
            .saturating_add(option.height.unwrap_or(0) as u64)
    };

    let option = probe
        .options
        .iter()
        .filter(|option| option.kind == FormatOptionKind::VideoWithAudio)
        .filter(|option| option.video_format_id.is_some() && option.audio_format_id.is_some())
        .min_by_key(by_size)
        .or_else(|| {
            probe
                .options
                .iter()
                .filter(|option| option.kind == FormatOptionKind::Progressive)
                .min_by_key(by_size)
        })
        .expect("at least one selectable option")
        .clone();

    eprintln!(
        "    · selected {} ({} · {:?})",
        option.label, option.detail, option.size_bytes
    );

    let selection = FormatSelection {
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
        mode: if option.kind == FormatOptionKind::VideoWithAudio {
            "video+audio".into()
        } else {
            "single".into()
        },
    };

    (selection, Some(option))
}

fn task(manager: &Arc<DownloadManager>, id: &str) -> DownloadTask {
    manager
        .get(id)
        .unwrap_or_else(|| panic!("task {id} must exist"))
}

// ---------------------------------------------------------------------------
// The full pipeline
// ---------------------------------------------------------------------------

#[test]
fn live_download_runs_the_whole_pipeline() {
    if !live() {
        eprintln!("skipping live pipeline test (set YTD_LIVE_TESTS=1 to enable)");
        return;
    }
    block_on(live_download_runs_the_whole_pipeline_inner());
}

async fn live_download_runs_the_whole_pipeline_inner() {
    let roots = scratch_roots("full");
    let settings = test_settings(&roots);
    let (manager, history) = build_manager(roots.clone(), settings).await;

    let (selection, _) = smallest_pair(&roots).await;
    let expected_merge = selection.needs_merge();

    let ids = manager.enqueue(vec![DownloadRequest {
        url: TEST_URL.into(),
        selection: Some(selection),
        playlist_indices: None,
        output_dir: None,
        title_hint: Some("Pipeline Test".into()),
        thumbnail_hint: None,
        uploader_hint: None,
        duration_hint: None,
        ignore_cookies: None,
    }]);
    assert_eq!(ids.len(), 1);
    let id = ids[0].clone();

    // The task must reach a terminal state on its own.
    let finished = wait_for(
        Duration::from_secs(420),
        || {
            let current = task(&manager, &id);
            if current.state.is_terminal() {
                Some(current)
            } else {
                None
            }
        },
        "the download to finish",
    )
    .await;

    assert_eq!(
        finished.state,
        TaskState::Completed,
        "download failed: {:?}",
        finished.error
    );

    // 1. A real file with real bytes.
    let output = finished.output.clone().expect("a result must be recorded");
    let path = PathBuf::from(&output.file_path);
    assert!(path.is_file(), "output file must exist: {}", output.file_path);
    assert!(
        output.size_bytes > 32 * 1024,
        "output should not be empty ({} bytes)",
        output.size_bytes
    );

    // 2. The merge really happened, and it kept the original codecs.
    if expected_merge {
        assert!(
            !output.merged_from.is_empty(),
            "a split-stream download must record which streams were muxed"
        );
        assert!(
            ["mkv", "webm", "mp4"].contains(&output.container.as_str()),
            "unexpected container {}",
            output.container
        );
    }

    // 3. ffprobe agrees the file is playable.
    let tools = runtime::resolve(&test_settings(&roots));
    let ffprobe = tools.ffprobe.expect("ffprobe");
    let probe_out = yt_downloader_lib::process::run_process(
        yt_downloader_lib::process::ProcessSpec::new(
            ffprobe,
            ffmpeg::ffprobe_args(&path),
            "verify pipeline output",
        )
        .with_timeout(60),
        Arc::new(ProcessRegistry::new()),
        "test:verify".into(),
        Arc::new(|_, _| {}),
    )
    .await
    .expect("ffprobe runs");
    assert!(probe_out.success(), "ffprobe must succeed");

    let facts = ffmpeg::parse_ffprobe(&probe_out.stdout_tail.join("\n")).expect("ffprobe json");
    assert!(facts.has_video, "result must have a video stream");
    assert!(facts.has_audio, "result must have an audio stream");
    assert!(
        facts.duration.unwrap_or(0.0) > 0.5,
        "result must have a real duration, got {:?}",
        facts.duration
    );

    // 4. Intermediates are cleaned up unless the user asked to keep them.
    let directory = PathBuf::from(&output.directory);
    let leftovers: Vec<String> = std::fs::read_dir(&directory)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.ends_with(".part") || name.ends_with(".ytdl"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "no partial files may remain after success: {leftovers:?}"
    );

    // 5. History recorded the download.
    let entries = history.list(None);
    assert_eq!(entries.len(), 1, "history must contain the finished task");
    assert_eq!(entries[0].task_id, finished.id);
    assert!(entries[0].file_path.is_some());
    assert_eq!(entries[0].size_bytes, output.size_bytes);

    println!(
        "pipeline ok: {} ({:.1} MB, {})",
        output.file_name,
        output.size_bytes as f64 / 1_048_576.0,
        output.container
    );

    let _ = std::fs::remove_dir_all(&roots.root);
}

// ---------------------------------------------------------------------------
// Pause / resume / cancel against real processes
// ---------------------------------------------------------------------------

#[test]
fn live_pause_and_cancel_control_real_processes() {
    if !live() {
        eprintln!("skipping live pause/cancel test (set YTD_LIVE_TESTS=1 to enable)");
        return;
    }
    block_on(live_pause_and_cancel_control_real_processes_inner());
}

async fn live_pause_and_cancel_control_real_processes_inner() {
    let roots = scratch_roots("pause");
    // A full download (no section limit) gives us something long enough to interrupt.
    let mut settings = test_settings(&roots);
    settings.limits.download_sections = String::new();
    let (manager, _history) = build_manager(roots.clone(), settings).await;

    let (mut selection, _) = smallest_pair(&roots).await;
    selection.size_bytes = None;

    let ids = manager.enqueue(vec![DownloadRequest {
        url: TEST_URL.into(),
        selection: Some(selection),
        playlist_indices: None,
        output_dir: None,
        title_hint: Some("Pause Test".into()),
        thumbnail_hint: None,
        uploader_hint: None,
        duration_hint: None,
        ignore_cookies: None,
    }]);
    let id = ids[0].clone();

    // Wait until real bytes are on the wire.
    let started = wait_for(
        Duration::from_secs(120),
        || {
            let current = task(&manager, &id);
            if current.progress.downloaded_bytes > 0
                || current.state == TaskState::Downloading
            {
                Some(current)
            } else if current.state == TaskState::Failed {
                panic!("task failed before it started downloading: {:?}", current.error);
            } else {
                None
            }
        },
        "the download to start",
    )
    .await;
    assert!(started.state.is_active(), "task should be active");

    // --- pause -------------------------------------------------------------
    manager.pause(&id).expect("pause");
    let paused = wait_for(
        Duration::from_secs(60),
        || {
            let current = task(&manager, &id);
            if current.state == TaskState::Paused {
                Some(current)
            } else if current.state == TaskState::Failed {
                panic!("pausing must not fail the task: {:?}", current.error);
            } else {
                None
            }
        },
        "the task to pause",
    )
    .await;
    assert_eq!(paused.state, TaskState::Paused);
    // The slot is released once the terminated process has been reaped.
    wait_for(
        Duration::from_secs(30),
        || (manager.active_count() == 0).then_some(()),
        "the concurrency slot to be released",
    )
    .await;

    // --- resume ------------------------------------------------------------
    manager.resume(&id).expect("resume");
    let resumed = wait_for(
        Duration::from_secs(120),
        || {
            let current = task(&manager, &id);
            if current.state == TaskState::Downloading || current.state == TaskState::Merging {
                Some(current)
            } else if current.state.is_terminal() {
                panic!("resumed task ended as {:?}", current.state);
            } else {
                None
            }
        },
        "the task to resume",
    )
    .await;
    assert!(resumed.state.is_active());

    // --- cancel ------------------------------------------------------------
    manager.cancel(&id).expect("cancel");
    let cancelled = wait_for(
        Duration::from_secs(60),
        || {
            let current = task(&manager, &id);
            if current.state == TaskState::Cancelled {
                Some(current)
            } else {
                None
            }
        },
        "the task to cancel",
    )
    .await;
    assert_eq!(cancelled.state, TaskState::Cancelled);
    assert!(
        cancelled.output.is_none(),
        "a cancelled task must not report an output file"
    );

    let _ = std::fs::remove_dir_all(&roots.root);
}

// ---------------------------------------------------------------------------
// Merge-only recovery
// ---------------------------------------------------------------------------

#[test]
fn live_merge_only_retry_reuses_downloaded_streams() {
    if !live() {
        eprintln!("skipping live merge-retry test (set YTD_LIVE_TESTS=1 to enable)");
        return;
    }
    block_on(live_merge_only_retry_reuses_downloaded_streams_inner());
}

async fn live_merge_only_retry_reuses_downloaded_streams_inner() {
    let roots = scratch_roots("merge-retry");
    // "Keep streams" preserves the per-stream files after a successful mux, which lets
    // this test reproduce the failure mode the recovery path exists for.
    let settings = manager_settings(&roots);
    let (manager, _history) = build_manager(roots.clone(), settings).await;

    let (selection, _) = smallest_pair(&roots).await;
    if !selection.needs_merge() {
        eprintln!("the smallest option is already muxed; merge retry cannot be exercised");
        return;
    }

    let ids = manager.enqueue(vec![DownloadRequest {
        url: TEST_URL.into(),
        selection: Some(selection),
        playlist_indices: None,
        output_dir: None,
        title_hint: Some("Merge Retry".into()),
        thumbnail_hint: None,
        uploader_hint: None,
        duration_hint: None,
        ignore_cookies: None,
    }]);
    let id = ids[0].clone();

    let finished = wait_for(
        Duration::from_secs(420),
        || {
            let current = task(&manager, &id);
            if current.state.is_terminal() {
                Some(current)
            } else {
                None
            }
        },
        "the download to finish",
    )
    .await;
    assert_eq!(finished.state, TaskState::Completed, "{:?}", finished.error);

    // The stream files were kept, so they must still be on disk.
    let video = finished
        .streams
        .iter()
        .find(|stream| stream.role == yt_downloader_lib::models::task::StreamRole::Video)
        .and_then(|stream| stream.path.clone())
        .expect("stream path recorded");
    let audio = finished
        .streams
        .iter()
        .find(|stream| stream.role == yt_downloader_lib::models::task::StreamRole::Audio)
        .and_then(|stream| stream.path.clone())
        .expect("stream path recorded");
    assert!(PathBuf::from(&video).is_file(), "video stream kept");
    assert!(PathBuf::from(&audio).is_file(), "audio stream kept");

    // Deleting the merged output simulates a mux failure: the recovery must be able to
    // rebuild it without touching the network.
    let output = finished.output.clone().unwrap();
    std::fs::remove_file(&output.file_path).expect("remove merged output");
    assert!(!PathBuf::from(&output.file_path).exists());

    manager.retry_merge(&id).expect("retry merge");

    let rebuilt = wait_for(
        Duration::from_secs(180),
        || {
            let current = task(&manager, &id);
            if current.state.is_terminal() {
                Some(current)
            } else {
                None
            }
        },
        "the merge-only retry to finish",
    )
    .await;

    assert_eq!(
        rebuilt.state,
        TaskState::Completed,
        "merge-only retry must succeed: {:?}",
        rebuilt.error
    );
    let rebuilt_output = rebuilt.output.expect("rebuilt output");
    assert!(
        PathBuf::from(&rebuilt_output.file_path).is_file(),
        "the merged file must exist again"
    );
    assert!(
        rebuilt.notices.iter().any(|notice| notice.contains("只重试合并")),
        "the task must record that it only re-ran the merge"
    );

    let _ = std::fs::remove_dir_all(&roots.root);
}

fn manager_settings(roots: &DataRoots) -> AppSettings {
    let mut settings = test_settings(roots);
    settings.downloads.keep_streams = true;
    settings
}
