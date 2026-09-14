//! Download task models.
//!
//! A task is the durable description of one download attempt; everything the UI
//! renders comes from here, so the frontend never has to guess at backend state.

use serde::{Deserialize, Serialize};

use super::media::MediaKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskState {
    /// Waiting for a free concurrency slot.
    Queued,
    /// Resolving the media before any byte is transferred.
    Probing,
    Downloading,
    /// Streams are on disk, muxing is in progress.
    Merging,
    Completed,
    /// Deliberately stopped by the user; partial files are kept for a resume.
    Paused,
    Cancelled,
    Failed,
}

impl TaskState {
    pub fn is_active(self) -> bool {
        matches!(self, Self::Probing | Self::Downloading | Self::Merging)
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Cancelled | Self::Failed)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Probing => "probing",
            Self::Downloading => "downloading",
            Self::Merging => "merging",
            Self::Completed => "completed",
            Self::Paused => "paused",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StreamRole {
    Video,
    Audio,
    Single,
}

impl StreamRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Video => "video",
            Self::Audio => "audio",
            Self::Single => "single",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StreamProgress {
    pub role: StreamRole,
    pub format_id: String,
    pub ext: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub speed: Option<f64>,
    pub eta: Option<f64>,
    pub path: Option<String>,
    pub finished: bool,
}

impl Default for StreamRole {
    fn default() -> Self {
        Self::Single
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    /// 0.0 – 1.0 across every stream of the task.
    pub percent: f64,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub speed: Option<f64>,
    pub eta: Option<f64>,
    pub stage: String,
    pub stage_percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub file_path: String,
    pub file_name: String,
    pub directory: String,
    pub size_bytes: u64,
    pub container: String,
    pub duration_seconds: Option<f64>,
    pub thumbnail_path: Option<String>,
    pub subtitle_paths: Vec<String>,
    /// Streams that were muxed together, in order.
    pub merged_from: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskError {
    pub summary: String,
    pub detail: Option<String>,
    /// Actionable guidance ("close Edge and retry", "use cookies.txt", …). Kept
    /// separate from `detail` so the UI can show it prominently and the raw stderr
    /// stays untouched for Expert Mode.
    #[serde(default)]
    pub hint: Option<String>,
    pub kind: String,
    pub exit_code: Option<i32>,
    pub command: Option<String>,
}

/// What the user picked in the format selector.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FormatSelection {
    pub kind: String,
    pub label: String,
    pub container: String,
    pub video_format_id: Option<String>,
    pub audio_format_id: Option<String>,
    pub single_format_id: Option<String>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub hdr: bool,
    pub size_bytes: Option<u64>,
    /// "video+audio" or "single" — drives the execution plan.
    pub mode: String,
}

impl FormatSelection {
    /// A muxed single format needs no FFmpeg step.
    pub fn needs_merge(&self) -> bool {
        self.video_format_id.is_some() && self.audio_format_id.is_some()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTask {
    pub id: String,
    pub url: String,
    pub title: String,
    pub thumbnail: Option<String>,
    pub uploader: Option<String>,
    pub duration: Option<f64>,
    pub kind: MediaKind,
    pub state: TaskState,
    pub progress: DownloadProgress,
    pub streams: Vec<StreamProgress>,
    pub selection: FormatSelection,
    pub output: Option<DownloadResult>,
    pub error: Option<TaskError>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub attempts: u32,
    pub playlist_index: Option<u64>,
    pub playlist_count: Option<u64>,
    pub playlist_title: Option<String>,
    /// Non-fatal messages worth showing in the card (retries, fallbacks, warnings).
    pub notices: Vec<String>,
    /// True when every stream finished but the mux step failed: the task can be
    /// completed by re-running FFmpeg alone, without touching the network.
    pub merge_ready: bool,
    /// Redacted argument list, shown only in Expert Mode.
    pub command_preview: Option<String>,
}

impl DownloadTask {
    pub fn new(id: String, url: String, created_at: String) -> Self {
        Self {
            id,
            url,
            title: String::new(),
            thumbnail: None,
            uploader: None,
            duration: None,
            kind: MediaKind::Video,
            state: TaskState::Queued,
            progress: DownloadProgress {
                stage: "等待中".into(),
                ..Default::default()
            },
            streams: Vec::new(),
            selection: FormatSelection::default(),
            output: None,
            error: None,
            created_at,
            started_at: None,
            finished_at: None,
            attempts: 0,
            playlist_index: None,
            playlist_count: None,
            playlist_title: None,
            notices: Vec::new(),
            merge_ready: false,
            command_preview: None,
        }
    }
}

/// Request payload used to enqueue one or more downloads.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub url: String,
    /// Pre-resolved selection. When absent the backend probes the URL first and
    /// applies the user's preferred quality from settings.
    #[serde(default)]
    pub selection: Option<FormatSelection>,
    /// Playlist entries the user unchecked.
    #[serde(default)]
    pub playlist_indices: Option<Vec<u64>>,
    /// Overrides the configured output directory for this task only.
    #[serde(default)]
    pub output_dir: Option<String>,
    #[serde(default)]
    pub title_hint: Option<String>,
    #[serde(default)]
    pub thumbnail_hint: Option<String>,
    #[serde(default)]
    pub uploader_hint: Option<String>,
    #[serde(default)]
    pub duration_hint: Option<f64>,
    /// Skip browser cookies for this request only.
    ///
    /// Set when the user asks to retry without cookies after the browser's cookie store
    /// turned out to be unreadable or undecryptable. It must not change the saved
    /// setting: the fallback applies to the task, not to the configuration.
    #[serde(default)]
    pub ignore_cookies: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn states_classify_correctly() {
        assert!(TaskState::Downloading.is_active());
        assert!(TaskState::Merging.is_active());
        assert!(!TaskState::Queued.is_active());
        assert!(TaskState::Completed.is_terminal());
        assert!(TaskState::Failed.is_terminal());
        assert!(!TaskState::Paused.is_terminal());
    }

    #[test]
    fn merge_is_only_needed_for_pairs() {
        let single = FormatSelection {
            single_format_id: Some("18".into()),
            mode: "single".into(),
            ..Default::default()
        };
        assert!(!single.needs_merge());

        let pair = FormatSelection {
            video_format_id: Some("137".into()),
            audio_format_id: Some("251".into()),
            mode: "video+audio".into(),
            ..Default::default()
        };
        assert!(pair.needs_merge());
    }

    #[test]
    fn state_names_are_stable_for_the_ui() {
        assert_eq!(TaskState::Queued.as_str(), "queued");
        assert_eq!(TaskState::Merging.as_str(), "merging");
        assert_eq!(StreamRole::Audio.as_str(), "audio");
    }
}
