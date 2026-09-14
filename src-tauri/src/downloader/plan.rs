//! Turning a selection into an executable plan.
//!
//! The plan is intentionally explicit: it names the exact files that will be written,
//! which stream each one belongs to, and whether a mux step is required. Because the
//! stream files are named deterministically, a task can be resumed, or its mux step
//! retried, without re-downloading anything.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::core::paths::{sanitise_file_name, unique_path};
use crate::models::media::{FormatOption, MediaKind, MediaProbe};
use crate::models::settings::AppSettings;
use crate::models::task::{DownloadRequest, FormatSelection, StreamRole};
use crate::services::ytdlp;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StreamTask {
    pub role: StreamRole,
    pub format_id: String,
    pub ext_hint: String,
    /// Path without extension: `<dir>\<base>.video`.
    pub prefix: PathBuf,
    pub expected_bytes: Option<u64>,
}

impl StreamTask {
    pub fn suffix(&self) -> String {
        match self.role {
            StreamRole::Video => format!("{}.video", display_stem(&self.prefix)),
            StreamRole::Audio => format!("{}.audio", display_stem(&self.prefix)),
            StreamRole::Single => display_stem(&self.prefix),
        }
    }

    /// File name prefix used when locating the finished download.
    pub fn file_stem(&self) -> String {
        self.prefix
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| "download".into())
    }
}

fn display_stem(prefix: &Path) -> String {
    prefix
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MergeSpec {
    pub container: String,
    pub embed_thumbnail: bool,
    pub embed_metadata: bool,
    pub embed_chapters: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskPlan {
    pub title: String,
    pub base_name: String,
    pub directory: PathBuf,
    pub streams: Vec<StreamTask>,
    pub merge: Option<MergeSpec>,
    pub final_path: Option<PathBuf>,
    pub write_thumbnail: bool,
}

impl TaskPlan {
    pub fn stream(&self, role: StreamRole) -> Option<&StreamTask> {
        self.streams.iter().find(|item| item.role == role)
    }

    pub fn needs_merge(&self) -> bool {
        self.merge.is_some()
    }
}

/// Build the plan for one task.
pub fn build_plan(
    settings: &AppSettings,
    request: &DownloadRequest,
    probe: Option<&MediaProbe>,
    selection: &FormatSelection,
    option: Option<&FormatOption>,
) -> TaskPlan {
    let title = request
        .title_hint
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| probe.map(|probe| probe.title.clone()))
        .unwrap_or_else(|| "download".into());

    let directory = resolve_directory(settings, request, probe);

    // A stable base name: the sanitised title, made unique if the file exists.
    let base = sanitise_file_name(&title);
    let base = if directory.join(format!("{base}.mkv")).exists()
        || directory.join(format!("{base}.webm")).exists()
        || directory.join(format!("{base}.mp4")).exists()
    {
        unique_path(&directory.join(&base))
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or(base)
    } else {
        base
    };

    // Container hints come from the selector row when it is known; otherwise the
    // selection itself carries the container the UI showed the user, which keeps the
    // muxed file's extension consistent with what was promised on screen.
    let video_ext = option
        .map(|option| option.container.clone())
        .or_else(|| {
            let container = selection.container.trim();
            if container.is_empty() {
                None
            } else {
                Some(container.to_ascii_lowercase())
            }
        })
        .unwrap_or_else(|| "webm".into());

    let mut streams: Vec<StreamTask> = Vec::new();
    let mut merge: Option<MergeSpec> = None;
    let final_path: Option<PathBuf>;

    if selection.needs_merge() {
        // An MP4 video stream is paired with AAC (m4a) audio, everything else with
        // WebM/Opus. This mirrors the backend's own format pairing rules.
        let video_container = video_ext.clone();
        let audio_ext = if video_container == "mp4" || video_container == "m4a" {
            "m4a"
        } else {
            "webm"
        };

        streams.push(StreamTask {
            role: StreamRole::Video,
            format_id: selection.video_format_id.clone().unwrap_or_default(),
            ext_hint: video_ext.clone(),
            prefix: directory.join(format!("{base}.video")),
            expected_bytes: option.and_then(|option| option.size_bytes),
        });
        streams.push(StreamTask {
            role: StreamRole::Audio,
            format_id: selection.audio_format_id.clone().unwrap_or_default(),
            ext_hint: audio_ext.to_string(),
            prefix: directory.join(format!("{base}.audio")),
            expected_bytes: None,
        });

        let mut container = ytdlp::resolve_container(
            settings.downloads.merge_container,
            &video_ext,
            audio_ext,
        );

        // WebM cannot carry an attached cover image; Matroska can, and every player
        // that understands WebM understands Matroska too.
        let wants_thumbnail = settings.downloads.embed_thumbnail;
        if wants_thumbnail && container == "webm" {
            container = "mkv".into();
        }

        final_path = Some(directory.join(format!("{base}.{container}")));
        merge = Some(MergeSpec {
            container,
            embed_thumbnail: wants_thumbnail,
            embed_metadata: settings.downloads.embed_metadata,
            embed_chapters: settings.downloads.embed_chapters,
        });
    } else {
        let ext = option
            .map(|option| {
                if option.kind == crate::models::media::FormatOptionKind::AudioOnly {
                    option.container.clone()
                } else {
                    option.container.clone()
                }
            })
            .unwrap_or_else(|| "webm".into());
        streams.push(StreamTask {
            role: StreamRole::Single,
            format_id: selection
                .single_format_id
                .clone()
                .unwrap_or_else(|| "bv*+ba/b".into()),
            ext_hint: ext.clone(),
            prefix: directory.join(&base),
            expected_bytes: option.and_then(|option| option.size_bytes),
        });
        final_path = None; // discovered from the download itself
    }
    TaskPlan {
        title,
        base_name: base,
        directory,
        streams,
        merge,
        final_path,
        write_thumbnail: settings.downloads.write_thumbnail || settings.downloads.embed_thumbnail,
    }
}

fn resolve_directory(
    settings: &AppSettings,
    request: &DownloadRequest,
    probe: Option<&MediaProbe>,
) -> PathBuf {
    let configured = request
        .output_dir
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| settings.downloads.output_dir.clone());

    let mut directory = PathBuf::from(configured.trim());

    // Playlists and channels get their own folder so a 200-video download stays tidy.
    if settings.downloads.playlist_subfolder {
        if let Some(probe) = probe {
            if probe.kind != MediaKind::Video {
                let folder = sanitise_file_name(&probe.title);
                if !folder.is_empty() {
                    directory = directory.join(folder);
                }
            }
        }
    }

    directory
}

/// Locate the finished file for a stream prefix.
///
/// `.part` files are never returned: yt-dlp only renames a file once it is complete,
/// so their presence means the stream still needs work.
pub fn find_stream_file(directory: &Path, prefix: &str) -> Option<PathBuf> {
    let ignore = [
        ".part", ".ytdl", ".jpg", ".jpeg", ".png", ".webp", ".srt", ".vtt", ".ass",
        ".description", ".info.json", ".temp",
    ];

    let mut best: Option<(PathBuf, u64)> = None;
    let entries = std::fs::read_dir(directory).ok()?;
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with(prefix) {
            continue;
        }
        let remainder = &name[prefix.len()..];
        // Must be `<prefix>.<ext>` and nothing else.
        let Some(extension) = remainder.strip_prefix('.') else {
            continue;
        };
        if extension.contains('.') || extension.is_empty() {
            continue;
        }
        if ignore
            .iter()
            .any(|suffix| extension.eq_ignore_ascii_case(suffix.trim_start_matches('.')))
        {
            continue;
        }

        let size = crate::core::fs_util::file_size(&path);
        if size == 0 {
            continue;
        }
        if best.as_ref().map(|(_, best_size)| size > *best_size).unwrap_or(true) {
            best = Some((path, size));
        }
    }

    best.map(|(path, _)| path)
}

/// Find a sidecar file (thumbnail or subtitle) that belongs to a prefix.
pub fn find_sidecar(directory: &Path, prefix: &str, extensions: &[&str]) -> Option<PathBuf> {
    let entries = std::fs::read_dir(directory).ok()?;
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with(prefix) {
            continue;
        }
        let lowered = name.to_ascii_lowercase();
        if extensions
            .iter()
            .any(|extension| lowered.ends_with(&format!(".{}", extension.trim_start_matches('.'))))
        {
            return Some(entry.path());
        }
    }
    None
}

/// Collect every subtitle file written for a prefix.
pub fn find_subtitles(directory: &Path, prefix: &str) -> Vec<PathBuf> {
    let mut found = Vec::new();
    if let Ok(entries) = std::fs::read_dir(directory) {
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(prefix) {
                let lowered = name.to_ascii_lowercase();
                if lowered.ends_with(".srt") || lowered.ends_with(".vtt") || lowered.ends_with(".ass") {
                    found.push(entry.path());
                }
            }
        }
    }
    found.sort();
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::task::DownloadRequest;

    fn settings() -> AppSettings {
        AppSettings::default()
    }

    fn request(url: &str) -> DownloadRequest {
        DownloadRequest {
            url: url.into(),
            selection: None,
            playlist_indices: None,
            output_dir: Some(r"E:\out".into()),
            title_hint: Some("My Video".into()),
            thumbnail_hint: None,
            uploader_hint: None,
            duration_hint: None,
            ignore_cookies: None,
        }
    }

    #[test]
    fn split_selection_produces_two_streams_and_a_merge() {
        let selection = FormatSelection {
            video_format_id: Some("399".into()),
            audio_format_id: Some("251".into()),
            container: "webm".into(),
            mode: "video+audio".into(),
            ..Default::default()
        };
        let option = FormatOption {
            container: "webm".into(),
            ..serde_json::from_str("{\"id\":\"x\",\"kind\":\"videoWithAudio\",\"label\":\"1080p\",\"detail\":\"\",\"container\":\"webm\",\"hdr\":false,\"recommended\":false,\"available\":true}").unwrap()
        };

        let plan = build_plan(&settings(), &request("u"), None, &selection, Some(&option));
        assert_eq!(plan.streams.len(), 2);
        assert_eq!(plan.streams[0].role, StreamRole::Video);
        assert!(plan.streams[0].prefix.ends_with("My Video.video"));
        assert!(plan.streams[1].prefix.ends_with("My Video.audio"));
        assert!(plan.needs_merge());
        // A thumbnail would be embedded by default, which forces Matroska.
        assert_eq!(plan.merge.as_ref().unwrap().container, "mkv");
        assert!(plan.final_path.unwrap().ends_with("My Video.mkv"));
    }

    #[test]
    fn webm_is_kept_when_no_thumbnail_is_embedded() {
        let mut settings = settings();
        settings.downloads.embed_thumbnail = false;
        let selection = FormatSelection {
            video_format_id: Some("248".into()),
            audio_format_id: Some("251".into()),
            container: "webm".into(),
            mode: "video+audio".into(),
            ..Default::default()
        };
        let plan = build_plan(&settings, &request("u"), None, &selection, None);
        assert_eq!(plan.merge.as_ref().unwrap().container, "webm");
        assert!(plan.final_path.unwrap().ends_with("My Video.webm"));
    }

    #[test]
    fn muxed_selection_needs_no_merge() {
        let selection = FormatSelection {
            single_format_id: Some("18".into()),
            container: "mp4".into(),
            mode: "single".into(),
            ..Default::default()
        };
        let plan = build_plan(&settings(), &request("u"), None, &selection, None);
        assert_eq!(plan.streams.len(), 1);
        assert_eq!(plan.streams[0].role, StreamRole::Single);
        assert!(!plan.needs_merge());
        assert!(plan.final_path.is_none());
    }

    #[test]
    fn titles_are_sanitised_into_file_names() {
        let mut request = request("u");
        request.title_hint = Some("A/B: Test? *Video*".into());
        let selection = FormatSelection {
            single_format_id: Some("18".into()),
            mode: "single".into(),
            ..Default::default()
        };
        let plan = build_plan(&settings(), &request, None, &selection, None);
        assert_eq!(plan.base_name, "A_B_ Test_ _Video_");
    }

    #[test]
    fn stream_files_are_found_and_partials_ignored() {
        let dir = std::env::temp_dir().join("ytd-plan-find");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("clip.video.webm.part"), vec![1u8; 900]).unwrap();
        assert!(find_stream_file(&dir, "clip.video").is_none());

        std::fs::write(dir.join("clip.video.webm"), vec![1u8; 500]).unwrap();
        let found = find_stream_file(&dir, "clip.video").unwrap();
        assert_eq!(found.extension().unwrap(), "webm");

        // A multi-dot extension means it is a sidecar, not the stream.
        std::fs::write(dir.join("clip.video.info.json"), vec![1u8; 10]).unwrap();
        let found = find_stream_file(&dir, "clip.video").unwrap();
        assert_eq!(found.extension().unwrap(), "webm");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sidecars_are_discovered() {
        let dir = std::env::temp_dir().join("ytd-plan-sidecar");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("clip.jpg"), b"x").unwrap();
        std::fs::write(dir.join("clip.zh-Hans.srt"), b"x").unwrap();

        assert!(find_sidecar(&dir, "clip", &["jpg", "png"]).unwrap().ends_with("clip.jpg"));
        let subtitles = find_subtitles(&dir, "clip");
        assert_eq!(subtitles.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
