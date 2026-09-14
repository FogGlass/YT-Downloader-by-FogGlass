//! Process execution: spawning, streaming, cancellation and cleanup.
//!
//! Every external program (`yt-dlp`, `ffmpeg`, `ffprobe`) goes through this module so
//! that there is exactly one place responsible for PIDs, pipes, exit codes, timeouts
//! and killing a process tree. Nothing else in the backend spawns a process.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::core::error::{AppError, AppResult};
use crate::{log_debug, log_warn};

/// Keep the console window from flashing when a child process starts.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const MAX_TAIL_LINES: usize = 120;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone)]
pub struct ProcessSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, String)>,
    /// Human readable label used in logs ("yt-dlp probe", "ffmpeg merge").
    pub label: String,
    /// Command line with secrets removed — safe to show in the UI.
    pub preview: String,
    pub timeout_seconds: Option<u64>,
}

impl ProcessSpec {
    pub fn new(program: impl Into<PathBuf>, args: Vec<String>, label: impl Into<String>) -> Self {
        let program = program.into();
        let label = label.into();
        let preview = render_preview(&program, &args);
        Self {
            program,
            args,
            cwd: None,
            env: Vec::new(),
            label,
            preview,
            timeout_seconds: None,
        }
    }

    pub fn with_cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    pub fn with_timeout(mut self, seconds: u64) -> Self {
        self.timeout_seconds = Some(seconds);
        self
    }
}

#[derive(Debug, Clone, Default)]
pub struct ProcessOutcome {
    pub code: Option<i32>,
    pub cancelled: bool,
    pub timed_out: bool,
    pub stdout_tail: Vec<String>,
    pub stderr_tail: Vec<String>,
}

impl ProcessOutcome {
    pub fn success(&self) -> bool {
        !self.cancelled && !self.timed_out && self.code == Some(0)
    }

    pub fn stderr_text(&self) -> String {
        self.stderr_tail.join("\n")
    }
}

/// A handle used by the download manager to stop a running task.
pub struct ProcessHandle {
    pid: u32,
    cancelled: Arc<AtomicBool>,
    label: String,
}

impl ProcessHandle {
    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn was_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Terminate the process *and its children* — FFmpeg is often a grandchild of
    /// the shell we spawned, and a plain `kill` would leave it writing to disk.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        log_debug!("process", "terminating pid {} ({})", self.pid, self.label);

        #[cfg(windows)]
        {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &self.pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .stdin(Stdio::null())
                .creation_flags_no_window()
                .status();
        }

        #[cfg(not(windows))]
        {
            let _ = std::process::Command::new("kill")
                .args(["-TERM", &self.pid.to_string()])
                .status();
        }
    }
}

#[cfg(windows)]
trait NoWindow {
    fn creation_flags_no_window(&mut self) -> &mut Self;
}

#[cfg(windows)]
impl NoWindow for std::process::Command {
    fn creation_flags_no_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(CREATE_NO_WINDOW)
    }
}

/// Registry of the processes currently owned by a task id.
#[derive(Default)]
pub struct ProcessRegistry {
    inner: Mutex<HashMap<String, Arc<ProcessHandle>>>,
}

impl ProcessRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn insert(&self, key: &str, handle: Arc<ProcessHandle>) {
        if let Ok(mut map) = self.inner.lock() {
            map.insert(key.to_string(), handle);
        }
    }

    fn remove(&self, key: &str) {
        if let Ok(mut map) = self.inner.lock() {
            map.remove(key);
        }
    }

    pub fn cancel(&self, key: &str) -> bool {
        let handle = self
            .inner
            .lock()
            .ok()
            .and_then(|map| map.get(key).cloned());
        match handle {
            Some(handle) => {
                handle.cancel();
                true
            }
            None => false,
        }
    }

    pub fn is_running(&self, key: &str) -> bool {
        self.inner
            .lock()
            .map(|map| map.contains_key(key))
            .unwrap_or(false)
    }

    pub fn active_count(&self) -> usize {
        self.inner.lock().map(|map| map.len()).unwrap_or(0)
    }
}

pub type LineSink = Arc<dyn Fn(ProcessStream, &str) + Send + Sync>;

/// Run a process to completion, streaming every line to `sink`.
pub async fn run_process(
    spec: ProcessSpec,
    registry: Arc<ProcessRegistry>,
    key: String,
    sink: LineSink,
) -> AppResult<ProcessOutcome> {
    if !spec.program.exists() {
        return Err(AppError::NotFound(format!(
            "找不到可执行文件：{}",
            spec.program.display()
        )));
    }

    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false);

    if let Some(cwd) = &spec.cwd {
        command.current_dir(cwd);
    }
    for (name, value) in &spec.env {
        command.env(name, value);
    }

    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    log_debug!("process", "spawn {} :: {}", spec.label, spec.preview);

    let mut child = command.spawn().map_err(|error| {
        AppError::Process(format!("无法启动 {}：{error}", spec.program.display()))
    })?;

    let pid = child.id().unwrap_or(0);
    let cancelled = Arc::new(AtomicBool::new(false));
    let handle = Arc::new(ProcessHandle {
        pid,
        cancelled: cancelled.clone(),
        label: spec.label.clone(),
    });
    registry.insert(&key, handle.clone());

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let stdout_tail = Arc::new(Mutex::new(Vec::<String>::new()));
    let stderr_tail = Arc::new(Mutex::new(Vec::<String>::new()));

    let stdout_task = stdout.map(|stream| {
        let sink = sink.clone();
        let tail = stdout_tail.clone();
        tokio::spawn(async move {
            pump_lines(stream, ProcessStream::Stdout, sink, tail).await;
        })
    });

    let stderr_task = stderr.map(|stream| {
        let sink = sink.clone();
        let tail = stderr_tail.clone();
        tokio::spawn(async move {
            pump_lines(stream, ProcessStream::Stderr, sink, tail).await;
        })
    });

    let mut timed_out = false;
    let status = match spec.timeout_seconds {
        Some(seconds) => match tokio::time::timeout(
            std::time::Duration::from_secs(seconds),
            child.wait(),
        )
        .await
        {
            Ok(result) => result?,
            Err(_) => {
                timed_out = true;
                log_warn!("process", "{} exceeded {}s, terminating", spec.label, seconds);
                handle.cancel();
                child.wait().await?
            }
        },
        None => child.wait().await?,
    };

    // Let the readers drain whatever is still buffered.
    if let Some(task) = stdout_task {
        let _ = task.await;
    }
    if let Some(task) = stderr_task {
        let _ = task.await;
    }

    registry.remove(&key);

    let outcome = ProcessOutcome {
        code: status.code(),
        cancelled: cancelled.load(Ordering::SeqCst),
        timed_out,
        stdout_tail: stdout_tail
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default(),
        stderr_tail: stderr_tail
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default(),
    };

    if !outcome.success() && !outcome.cancelled {
        log_warn!(
            "process",
            "{} exited code={:?} timed_out={} stderr_tail={}",
            spec.label,
            outcome.code,
            outcome.timed_out,
            outcome
                .stderr_tail
                .last()
                .cloned()
                .unwrap_or_else(|| "—".into())
        );
    }

    Ok(outcome)
}

fn push_tail(tail: &Arc<Mutex<Vec<String>>>, line: &str) {
    if let Ok(mut guard) = tail.lock() {
        if guard.len() >= MAX_TAIL_LINES {
            guard.remove(0);
        }
        guard.push(line.to_string());
    }
}

/// Drain a child stream line by line until end of file.
///
/// The stream is read as **bytes** and never as text: an output line is arbitrary
/// bytes, and a decoding failure is a display detail, not a reason to stop reading.
/// Aborting the reader here used to drop the read end of the pipe, after which the
/// child's next flush failed with `EINVAL` — yt-dlp reported that as
/// `Unable to download video: [Errno 22] Invalid argument` and the download died
/// halfway through. Every byte of every line is therefore decoded lossily instead.
async fn pump_lines<R>(
    mut stream: R,
    kind: ProcessStream,
    sink: LineSink,
    tail: Arc<Mutex<Vec<String>>>,
) where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut pending: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 8192];

    loop {
        let read = match stream.read(&mut chunk).await {
            Ok(0) => break,
            Ok(count) => count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => {
                // A genuine read failure ends the stream; it can never be caused by
                // the content of a line.
                log_debug!("process", "{:?} stream read failed: {}", kind, error);
                break;
            }
        };

        pending.extend_from_slice(&chunk[..read]);
        for line in take_lines(&mut pending) {
            push_tail(&tail, &line);
            sink(kind, &line);
        }
    }

    // A final line without a trailing newline still belongs to the output.
    if !pending.is_empty() {
        let line = decode_line(&pending);
        push_tail(&tail, &line);
        sink(kind, &line);
    }
}

/// Remove and decode every complete line currently held in `pending`.
fn take_lines(pending: &mut Vec<u8>) -> Vec<String> {
    let mut lines = Vec::new();
    while let Some(index) = pending.iter().position(|byte| *byte == b'\n') {
        let mut raw: Vec<u8> = pending.drain(..=index).collect();
        raw.pop();
        lines.push(decode_line(&raw));
    }
    lines
}

/// Decode one output line: exact UTF-8 when possible, lossy otherwise.
fn decode_line(raw: &[u8]) -> String {
    let raw = raw.strip_suffix(b"\r").unwrap_or(raw);
    match std::str::from_utf8(raw) {
        Ok(text) => text.to_string(),
        Err(_) => String::from_utf8_lossy(raw).into_owned(),
    }
}

/// Render a command line for the UI with secret-bearing arguments masked.
pub fn render_preview(program: &std::path::Path, args: &[String]) -> String {
    let mut rendered = Vec::with_capacity(args.len() + 1);
    rendered.push(quote_argument(&program.to_string_lossy()));

    let mut index = 0;
    while index < args.len() {
        let argument = &args[index];
        if crate::services::ytdlp::secrets::is_secret_flag(argument) {
            // `--cookies` (separate value) and `--password=secret` (inline value) are
            // both secret-bearing; the raw text never reaches the preview.
            rendered.push(quote_argument(&crate::services::ytdlp::secrets::redact_value(argument)));
            if !argument.contains('=') && index + 1 < args.len() {
                rendered.push("«已隐藏»".to_string());
                index += 1;
            }
            index += 1;
            continue;
        }
        rendered.push(quote_argument(&crate::services::ytdlp::secrets::redact_value(argument)));
        index += 1;
    }

    rendered.join(" ")
}

fn quote_argument(value: &str) -> String {
    if value.is_empty() {
        return "\"\"".into();
    }
    if value.contains(' ') || value.contains('\t') {
        format!("\"{value}\"")
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_masks_cookie_permissions() {
        let args = vec![
            "--cookies".to_string(),
            r"E:\secrets\cookies.txt".to_string(),
            "--output".to_string(),
            "%(title)s.%(ext)s".to_string(),
        ];
        let preview = render_preview(std::path::Path::new("yt-dlp.exe"), &args);
        assert!(!preview.contains("cookies.txt"));
        assert!(preview.contains("已隐藏"));
        assert!(preview.contains("%(title)s.%(ext)s"));
    }

    #[test]
    fn preview_masks_inline_secret_values() {
        let args = vec!["--password=letmein".to_string()];
        let preview = render_preview(std::path::Path::new("yt-dlp.exe"), &args);
        assert!(!preview.contains("letmein"));
    }

    #[test]
    fn preview_quotes_spaced_arguments() {
        let args = vec!["--output".to_string(), r"E:\My Videos\a.mp4".to_string()];
        let preview = render_preview(std::path::Path::new("yt-dlp.exe"), &args);
        assert!(preview.contains("\"E:\\My Videos\\a.mp4\""));
    }

    #[test]
    fn decode_keeps_exact_utf8_and_strips_windows_line_ends() {
        assert_eq!(decode_line("进度 50%".as_bytes()), "进度 50%");
        assert_eq!(decode_line(b"YTPROG|downloading|2048\r"), "YTPROG|downloading|2048");
    }

    #[test]
    fn a_line_that_is_not_utf8_is_decoded_lossily_instead_of_dropped() {
        // GBK bytes for "下载" — what a Python child writes on a Chinese Windows.
        let raw = [0xD0u8, 0xC2, 0xD4, 0xD8];
        let decoded = decode_line(&raw);
        assert!(!decoded.is_empty());
        assert!(decoded.contains('\u{FFFD}'));
    }

    #[test]
    fn every_complete_line_is_taken_and_partials_are_kept() {
        // The trailing line has no newline yet, so it stays buffered until the rest
        // of it (or the end of the stream) arrives.
        let mut pending = b"first\nsecond\r\nthird".to_vec();
        let lines = take_lines(&mut pending);
        assert_eq!(lines, vec!["first".to_string(), "second".to_string()]);
        assert_eq!(pending, b"third".to_vec());
    }

    #[tokio::test]
    async fn a_non_utf8_line_never_ends_the_stream() {
        // Regression: the reader used to stop at the first line that was not valid
        // UTF-8, which closed the read end of the pipe; the child's next flush then
        // failed with EINVAL and yt-dlp aborted the download with
        // "Unable to download video: [Errno 22] Invalid argument".
        let mut bytes: Vec<u8> = b"[download] Destination: ".to_vec();
        bytes.extend_from_slice(&[0xD0, 0xC2, 0xD4, 0xD8, 0xA3, 0xA1]); // GBK text
        bytes.extend_from_slice(b"\nYTPROG|downloading|1024\nplain\npartial");

        let collected: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink: LineSink = {
            let collected = collected.clone();
            Arc::new(move |_stream, line| {
                if let Ok(mut guard) = collected.lock() {
                    guard.push(line.to_string());
                }
            })
        };
        let tail = Arc::new(Mutex::new(Vec::new()));

        pump_lines(&bytes[..], ProcessStream::Stdout, sink, tail.clone()).await;

        let lines = collected.lock().map(|guard| guard.clone()).unwrap_or_default();
        assert_eq!(lines.len(), 4, "lines: {lines:?}");
        assert!(lines[0].starts_with("[download] Destination: "));
        assert_eq!(lines[1], "YTPROG|downloading|1024");
        assert_eq!(lines[2], "plain");
        assert_eq!(lines[3], "partial");
        assert_eq!(tail.lock().map(|guard| guard.len()).unwrap_or(0), 4);
    }
}
