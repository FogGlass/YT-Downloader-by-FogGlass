//! yt-dlp integration: probing, downloading, progress and failure reporting.

pub mod args;
pub mod errors;
pub mod json;
pub mod progress;
pub mod secrets;

use std::sync::{Arc, Mutex};

use serde_json::Value;

use crate::core::error::{AppError, AppResult};
use crate::core::paths::DataRoots;
use crate::models::media::MediaProbe;
use crate::models::settings::{AppSettings, CookieMode};
use crate::process::{run_process, LineSink, ProcessRegistry, ProcessStream};
use crate::runtime::{yt_dlp_spec, ToolSet};
use crate::{log_debug, log_info};

pub use args::{
    candidate_extensions, cookies_are_effective, fallback_format_expression, is_playlist_url,
    probe_args, resolve_container, selection_summary,
    split_extra_args, stream_args, thumbnail_args, StreamSpec,
};
pub use errors::{classify, from_outcome, hint_for, salient_line, FailureKind};
pub use json::{build_format_options, format_expression, parse_probe};
pub use progress::{PostProcessUpdate, ProgressUpdate, PROGRESS_PREFIX};

/// Run a metadata probe and parse the result.
///
/// `ignore_cookies` performs the probe as if no browser cookies were configured. It is
/// the fallback offered when a browser's cookie store cannot be read — the parse is
/// re-run rather than the task being abandoned.
pub async fn probe(
    settings: &AppSettings,
    roots: &DataRoots,
    tools: &ToolSet,
    registry: Arc<ProcessRegistry>,
    url: &str,
    playlist: bool,
    ignore_cookies: bool,
) -> AppResult<MediaProbe> {
    let effective;
    let settings = if ignore_cookies {
        effective = {
            let mut clone = settings.clone();
            clone.cookies.mode = CookieMode::None;
            clone
        };
        &effective
    } else {
        settings
    };

    let arguments = probe_args(settings, roots, tools, url, playlist);
    let spec = yt_dlp_spec(tools, arguments, "yt-dlp probe").with_timeout(180);

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

    log_info!("ytdlp", "probing {}", url);
    let outcome = run_process(spec, registry, "probe".into(), sink).await?;

    if outcome.cancelled {
        return Err(AppError::Message("解析已取消".into()));
    }

    let payload = collected
        .lock()
        .map(|guard| guard.join("\n"))
        .unwrap_or_default();

    if payload.trim().is_empty() {
        // Classify the failure so the interface can say what actually went wrong —
        // notably "the browser's cookie store could not be decrypted" instead of a
        // generic parse error or a misleading login prompt.
        let error = from_outcome(&outcome);
        return Err(AppError::Classified {
            kind: error.kind.clone(),
            summary: error.summary.clone(),
            hint: error.hint.clone().or_else(|| hint_for(FailureKind::Runtime)),
            detail: error.detail.clone(),
        });
    }

    let value: Value = serde_json::from_str(&payload).map_err(|error| {
        AppError::Process(format!(
            "无法解析 yt-dlp 输出：{error}（前 200 字符：{}）",
            payload.chars().take(200).collect::<String>()
        ))
    })?;

    let mut probe = parse_probe(&value, url);
    // Derive the selector rows with the user's live preferences.
    probe.options = build_format_options(&probe.formats, settings);

    log_debug!(
        "ytdlp",
        "probe complete: kind={:?} formats={} options={} entries={}",
        probe.kind,
        probe.formats.len(),
        probe.options.len(),
        probe.entries.len()
    );

    Ok(probe)
}

/// Result of a single stream download.
#[derive(Debug, Clone)]
pub struct StreamOutcome {
    pub files: Vec<std::path::PathBuf>,
    pub outcome: crate::process::ProcessOutcome,
}

impl StreamOutcome {
    pub fn largest(&self) -> Option<std::path::PathBuf> {
        self.files
            .iter()
            .filter(|path| {
                let name = path.file_name().map(|value| value.to_string_lossy().to_string());
                !name
                    .as_deref()
                    .map(|value| value.ends_with(".part") || value.ends_with(".ytdl"))
                    .unwrap_or(false)
            })
            .max_by_key(|path| crate::core::fs_util::file_size(path))
            .cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn playlist_detection_is_shared_with_the_argument_builder() {
        assert!(is_playlist_url("https://www.youtube.com/@channel/videos"));
        assert!(!is_playlist_url("https://youtu.be/abc"));
    }

    #[test]
    fn stream_outcome_ignores_partial_files() {
        let dir = std::env::temp_dir().join("ytd-stream-outcome");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("clip.video.webm.part"), vec![0u8; 4096]).unwrap();
        std::fs::write(dir.join("clip.video.webm"), vec![0u8; 128]).unwrap();

        let outcome = StreamOutcome {
            files: vec![
                dir.join("clip.video.webm.part"),
                dir.join("clip.video.webm"),
            ],
            outcome: crate::process::ProcessOutcome::default(),
        };
        assert!(outcome.largest().unwrap().ends_with("clip.video.webm"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
