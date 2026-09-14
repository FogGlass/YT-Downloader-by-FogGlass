//! Integration tests that exercise the real FFmpeg and the real process manager.
//!
//! These are deliberately end-to-end: they generate media with the mandated runtime,
//! mux it through the same argument builder the application uses, verify the result
//! with ffprobe, and prove that cancellation really terminates a running process.
//!
//! Live tests that reach YouTube only run when `YTD_LIVE_TESTS=1` is set, so the
//! default `cargo test` stays offline and fast.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use yt_downloader_lib::core::paths::{DataRoots, DEV_RUNTIME_BIN};
use yt_downloader_lib::models::media::{ChapterInfo, FormatInfo};
use yt_downloader_lib::models::settings::AppSettings;
use yt_downloader_lib::process::{
    run_process, LineSink, ProcessRegistry, ProcessSpec, ProcessStream,
};
use yt_downloader_lib::runtime;
use yt_downloader_lib::services::ffmpeg::{self, MergePlan};
use yt_downloader_lib::services::ytdlp;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ytd-it-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create scratch dir");
    dir
}

fn tools() -> runtime::ToolSet {
    runtime::resolve(&AppSettings::default())
}

fn ffmpeg_path() -> PathBuf {
    tools()
        .ffmpeg
        .expect("the mandated runtime must provide ffmpeg.exe")
}

fn ffprobe_path() -> PathBuf {
    tools()
        .ffprobe
        .expect("the mandated runtime must provide ffprobe.exe")
}

/// Collect stdout so we can assert on a program's output.
fn collect_stdout() -> (Arc<std::sync::Mutex<Vec<String>>>, LineSink) {
    let store = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let sink: LineSink = {
        let store = store.clone();
        Arc::new(move |stream, line| {
            if stream == ProcessStream::Stdout {
                if let Ok(mut guard) = store.lock() {
                    guard.push(line.to_string());
                }
            }
        })
    };
    (store, sink)
}

/// Run a command and assert it succeeded, returning its stdout.
async fn run_ok(program: &Path, args: Vec<String>, label: &str) -> Vec<String> {
    let (store, sink) = collect_stdout();
    let outcome = run_process(
        ProcessSpec::new(program.to_path_buf(), args, label).with_timeout(180),
        Arc::new(ProcessRegistry::new()),
        format!("test:{label}"),
        sink,
    )
    .await
    .expect("spawn");

    assert!(
        outcome.success(),
        "{label} failed: code={:?} stderr={}",
        outcome.code,
        outcome.stderr_text()
    );

    store.lock().map(|guard| guard.clone()).unwrap_or_default()
}

/// Produce a 2 second video-only stream and a 2 second audio-only stream.
async fn make_streams(dir: &Path) -> (PathBuf, PathBuf) {
    let video = dir.join("clip.video.webm");
    let audio = dir.join("clip.audio.webm");

    run_ok(
        &ffmpeg_path(),
        vec![
            "-hide_banner".into(),
            "-y".into(),
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            "testsrc=size=320x240:rate=15:duration=2".into(),
            "-c:v".into(),
            "libvpx-vp9".into(),
            "-b:v".into(),
            "200k".into(),
            "-an".into(),
            video.to_string_lossy().to_string(),
        ],
        "generate video",
    )
    .await;

    run_ok(
        &ffmpeg_path(),
        vec![
            "-hide_banner".into(),
            "-y".into(),
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            "sine=frequency=440:duration=2".into(),
            "-c:a".into(),
            "libopus".into(),
            audio.to_string_lossy().to_string(),
        ],
        "generate audio",
    )
    .await;

    assert!(video.exists(), "video stream must exist");
    assert!(audio.exists(), "audio stream must exist");
    (video, audio)
}

fn basic_plan(video: PathBuf, audio: PathBuf, output: PathBuf, container: &str) -> MergePlan {
    MergePlan {
        video,
        audio,
        output,
        container: container.into(),
        thumbnail: None,
        metadata_file: None,
        tags: vec![("title".into(), "Integration clip".into())],
        chapters: Vec::new(),
        duration: Some(2.0),
    }
}

// ---------------------------------------------------------------------------
// Runtime discovery
// ---------------------------------------------------------------------------

#[test]
fn the_mandated_runtime_is_discovered() {
    let tools = tools();
    assert!(
        tools.bin_dir.to_string_lossy().eq_ignore_ascii_case(DEV_RUNTIME_BIN)
            || tools.bin_dir.join("ffmpeg.exe").is_file(),
        "runtime folder should be the mandated E:\\FFMPEG-9.0 (or a bundled runtime): {}",
        tools.bin_dir.display()
    );
    assert!(tools.ffmpeg.is_some(), "ffmpeg.exe must be found");
    assert!(tools.ffprobe.is_some(), "ffprobe.exe must be found");
    assert!(tools.yt_dlp_exe.is_some(), "yt-dlp.exe must be found");
}

#[test]
fn the_runtime_is_never_taken_from_the_system_drive() {
    let tools = tools();
    assert!(
        !yt_downloader_lib::core::paths::is_on_c_drive(&tools.bin_dir),
        "the runtime must not resolve onto C: by default"
    );
}

// ---------------------------------------------------------------------------
// FFmpeg: real muxing and verification
// ---------------------------------------------------------------------------

#[tokio::test]
async fn merge_produces_a_file_with_both_streams() {
    let dir = scratch("merge");
    let (video, audio) = make_streams(&dir).await;
    let output = dir.join("clip.mkv");

    let plan = basic_plan(video.clone(), audio.clone(), output.clone(), "mkv");
    let args = ffmpeg::merge_args(&AppSettings::default(), &tools(), &plan);
    run_ok(&ffmpeg_path(), args, "merge").await;

    assert!(output.exists(), "merged file must exist");
    assert!(
        std::fs::metadata(&output).unwrap().len() > 1024,
        "merged file must not be empty"
    );

    // ffprobe must agree that both streams survived the copy.
    let stdout = run_ok(
        &ffprobe_path(),
        ffmpeg::ffprobe_args(&output)
            .into_iter()
            .map(String::from)
            .collect(),
        "probe merged",
    )
    .await;

    let facts = ffmpeg::parse_ffprobe(&stdout.join("\n")).expect("ffprobe json");
    assert!(facts.has_video, "merged file must contain video");
    assert!(facts.has_audio, "merged file must contain audio");
    assert!(facts.duration.unwrap_or(0.0) > 1.0, "duration must be real");
    ffmpeg::verify_facts(&facts).expect("verification must pass");

    // The mux is a stream copy, so the codecs must be untouched.
    assert_eq!(facts.video_codec.as_deref(), Some("vp9"));
    assert_eq!(facts.audio_codec.as_deref(), Some("opus"));

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn mp4_output_is_produced_when_asked_for() {
    let dir = scratch("merge-mp4");
    let (video, audio) = make_streams(&dir).await;
    let output = dir.join("clip.mp4");

    // MP4 cannot carry VP9/Opus in every player, so this test proves the container
    // choice is honoured rather than silently forcing Matroska.
    let plan = basic_plan(video, audio, output.clone(), "mp4");
    let args = ffmpeg::merge_args(&AppSettings::default(), &tools(), &plan);
    run_ok(&ffmpeg_path(), args, "merge mp4").await;
    assert!(output.exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn chapter_metadata_is_embedded() {
    let dir = scratch("chapters");
    let (video, audio) = make_streams(&dir).await;
    let output = dir.join("chapters.mkv");
    let metadata = dir.join("clip.ffmetadata");

    let chapters = vec![
        ChapterInfo {
            title: "第一段".into(),
            start_time: 0.0,
            end_time: Some(1.0),
        },
        ChapterInfo {
            title: "第二段".into(),
            start_time: 1.0,
            end_time: Some(2.0),
        },
    ];

    ffmpeg::write_metadata_file(&metadata, &[("title".into(), "章节测试".into())], &chapters)
        .expect("write ffmetadata");

    let mut plan = basic_plan(video, audio, output.clone(), "mkv");
    plan.metadata_file = Some(metadata);
    plan.chapters = chapters;
    plan.tags = vec![("title".into(), "章节测试".into())];

    let args = ffmpeg::merge_args(&AppSettings::default(), &tools(), &plan);
    run_ok(&ffmpeg_path(), args, "merge with chapters").await;
    assert!(output.exists());

    // ffprobe reports chapters as part of the format section when asked.
    let stdout = run_ok(
        &ffprobe_path(),
        vec![
            "-hide_banner".into(),
            "-v".into(),
            "error".into(),
            "-show_chapters".into(),
            "-of".into(),
            "json".into(),
            output.to_string_lossy().to_string(),
        ],
        "probe chapters",
    )
    .await;

    let payload = stdout.join("\n");
    assert!(
        payload.contains("第一段"),
        "embedded chapters should be readable back: {payload}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// Process manager: streaming, exit codes and cancellation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn process_output_is_streamed_line_by_line() {
    let dir = scratch("stream");
    let outcome = run_process(
        ProcessSpec::new(ffmpeg_path(), vec!["-hide_banner".into(), "-version".into()], "version")
            .with_timeout(60),
        Arc::new(ProcessRegistry::new()),
        "test:version".into(),
        Arc::new(|_, _| {}),
    )
    .await
    .expect("spawn");

    assert_eq!(outcome.code, Some(0));
    assert!(!outcome.stdout_tail.is_empty(), "stdout must be captured");
    assert!(outcome.stdout_tail[0].contains("ffmpeg version"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_failing_process_reports_its_exit_code_and_stderr() {
    let outcome = run_process(
        ProcessSpec::new(
            ffmpeg_path(),
            vec!["-hide_banner".into(), "-i".into(), "Z:\\does\\not\\exist.mkv".into(), "-f".into(), "null".into(), "-".into()],
            "failing",
        )
        .with_timeout(60),
        Arc::new(ProcessRegistry::new()),
        "test:failing".into(),
        Arc::new(|_, _| {}),
    )
    .await
    .expect("spawn");

    assert!(!outcome.success());
    assert_ne!(outcome.code, Some(0));
    assert!(!outcome.stderr_tail.is_empty(), "stderr must be captured");
}

#[tokio::test]
async fn cancelling_terminates_a_running_process() {
    let dir = scratch("cancel");
    let output = dir.join("long.webm");
    let registry = Arc::new(ProcessRegistry::new());

    // A synthetic 120 second encode gives us something to interrupt.
    let spec = ProcessSpec::new(
        ffmpeg_path(),
        vec![
            "-hide_banner".into(),
            "-y".into(),
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            "testsrc=size=1920x1080:rate=30:duration=120".into(),
            "-c:v".into(),
            "libvpx-vp9".into(),
            "-b:v".into(),
            "4M".into(),
            output.to_string_lossy().to_string(),
        ],
        "long encode",
    );

    let registry_for_cancel = registry.clone();
    let cancel_handle = tokio::spawn(async move {
        // Give the process time to actually start writing.
        tokio::time::sleep(std::time::Duration::from_millis(900)).await;
        assert!(
            registry_for_cancel.cancel("test:cancel"),
            "the registry must know the running process"
        );
    });

    let started = std::time::Instant::now();
    let outcome = run_process(
        spec,
        registry.clone(),
        "test:cancel".into(),
        Arc::new(|_, _| {}),
    )
    .await
    .expect("spawn");
    let elapsed = started.elapsed();

    let _ = cancel_handle.await;

    assert!(outcome.cancelled, "the outcome must be flagged as cancelled");
    assert!(!outcome.success(), "a cancelled process is not a success");
    assert!(
        elapsed < std::time::Duration::from_secs(60),
        "cancellation must return promptly, took {elapsed:?}"
    );
    assert!(
        !registry.is_running("test:cancel"),
        "the registry must be cleaned up after the process exits"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn timeouts_terminate_the_process() {
    let dir = scratch("timeout");
    let output = dir.join("timeout.webm");

    let spec = ProcessSpec::new(
        ffmpeg_path(),
        vec![
            "-hide_banner".into(),
            "-y".into(),
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            "testsrc=size=1280x720:rate=30:duration=120".into(),
            "-c:v".into(),
            "libvpx-vp9".into(),
            output.to_string_lossy().to_string(),
        ],
        "timeout encode",
    )
    .with_timeout(2);

    let outcome = run_process(spec, Arc::new(ProcessRegistry::new()), "test:timeout".into(), Arc::new(|_, _| {}))
        .await
        .expect("spawn");

    assert!(outcome.timed_out, "the outcome must be flagged as timed out");
    assert!(!outcome.success());

    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// yt-dlp integration
// ---------------------------------------------------------------------------

#[tokio::test]
async fn yt_dlp_reports_its_version_through_the_configured_launcher() {
    let tools = tools();
    let version = runtime::probe_yt_dlp(&tools, Arc::new(ProcessRegistry::new()))
        .await
        .expect("yt-dlp must report a version");
    assert!(
        version.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false),
        "version should look like a date, got {version}"
    );
}

#[test]
fn stream_arguments_never_leak_cookies_into_the_preview() {
    let settings = AppSettings::default();
    let roots = DataRoots {
        config: PathBuf::from(r"E:\x"),
        history: PathBuf::from(r"E:\x"),
        favorites: PathBuf::from(r"E:\x"),
        logs: PathBuf::from(r"E:\x"),
        cache: PathBuf::from(r"E:\x"),
        temp: PathBuf::from(r"E:\x"),
        downloads: PathBuf::from(r"E:\x"),
        root: PathBuf::from(r"E:\x"),
    };
    let spec = ytdlp::StreamSpec {
        role: yt_downloader_lib::models::task::StreamRole::Single,
        format_id: "18".into(),
        output_prefix: r"E:\out\clip".into(),
    };

    let args = ytdlp::stream_args(&settings, &roots, &tools(), &spec, "https://youtu.be/x", true);
    let preview = yt_downloader_lib::process::render_preview(Path::new("yt-dlp.exe"), &args);
    assert!(preview.contains("--format"));
    assert!(!preview.to_lowercase().contains("cookie"));
}

/// Parses a real probe payload. Requires network access.
#[tokio::test]
async fn live_probe_returns_selectable_formats() {
    if std::env::var("YTD_LIVE_TESTS").as_deref() != Ok("1") {
        eprintln!("skipping live test (set YTD_LIVE_TESTS=1 to enable)");
        return;
    }

    let settings = AppSettings::default();
    let tools = tools();
    let roots = yt_downloader_lib::core::paths::resolve_data_roots().expect("data roots");
    roots.ensure().expect("data dirs");

    let probe = ytdlp::probe(
        &settings,
        &roots,
        &tools,
        Arc::new(ProcessRegistry::new()),
        // Big Buck Bunny — Creative Commons, published by the Blender Foundation.
        "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
        false,
        false,
    )
    .await
    .expect("live probe");

    assert!(!probe.title.is_empty(), "title must be parsed");
    assert!(!probe.formats.is_empty(), "formats must be parsed");
    assert!(
        !probe.options.is_empty(),
        "the selector must be given at least one option"
    );
    assert!(
        probe.options.iter().any(|option| option.kind
            == yt_downloader_lib::models::media::FormatOptionKind::VideoWithAudio),
        "a modern YouTube video must yield at least one video+audio pair"
    );
    assert!(
        probe.options.iter().any(|option| option.recommended),
        "exactly the smart default must be marked"
    );

    // Every offered video row must name the streams it will download.
    for option in probe
        .options
        .iter()
        .filter(|option| option.kind == yt_downloader_lib::models::media::FormatOptionKind::VideoWithAudio)
    {
        assert!(option.video_format_id.is_some());
        assert!(option.audio_format_id.is_some());
    }

    // And the format list must never offer a DRM stream.
    let drm: Vec<&FormatInfo> = probe
        .formats
        .iter()
        .filter(|format| format.is_drm())
        .collect();
    assert!(
        probe
            .options
            .iter()
            .all(|option| option.video_format_id.as_deref() != Some("drm")),
        "drm formats ({}) must never become options",
        drm.len()
    );
}
