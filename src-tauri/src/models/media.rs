//! Media models produced by `yt-dlp --dump-single-json`.
//!
//! The raw extractor payload is huge and unstable; these types keep only what the
//! workbench actually renders, and add the derived information (codec labels,
//! bitrate totals, stream pairing) that the format selector needs.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaKind {
    Video,
    Playlist,
    Channel,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailInfo {
    pub url: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub preference: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FormatInfo {
    pub format_id: String,
    pub ext: String,
    pub vcodec: Option<String>,
    pub acodec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub dynamic_range: Option<String>,
    pub tbr: Option<f64>,
    pub vbr: Option<f64>,
    pub abr: Option<f64>,
    pub audio_channels: Option<u32>,
    pub audio_sample_rate: Option<u32>,
    pub filesize: Option<u64>,
    pub filesize_approx: Option<u64>,
    pub protocol: Option<String>,
    pub language: Option<String>,
    pub format_note: Option<String>,
    pub quality: Option<f64>,
}

impl FormatInfo {
    pub fn has_video(&self) -> bool {
        self.vcodec
            .as_deref()
            .map(|codec| codec != "none" && !codec.is_empty())
            .unwrap_or(false)
    }

    pub fn has_audio(&self) -> bool {
        self.acodec
            .as_deref()
            .map(|codec| codec != "none" && !codec.is_empty())
            .unwrap_or(false)
    }

    pub fn is_progressive(&self) -> bool {
        self.has_video() && self.has_audio()
    }

    /// DRM-protected formats are surfaced but never selectable.
    pub fn is_drm(&self) -> bool {
        self.format_id.starts_with("drm")
    }

    pub fn is_hdr(&self) -> bool {
        matches!(
            self.dynamic_range.as_deref().map(str::to_ascii_lowercase).as_deref(),
            Some("hdr") | Some("hdr10") | Some("hdr10+") | Some("hlg") | Some("dolby vision") | Some("dvhdr")
        )
    }

    pub fn size_estimate(&self) -> Option<u64> {
        self.filesize.or(self.filesize_approx)
    }

    /// "AV1" / "VP9" / "H.264" — the short labels the UI shows next to a resolution.
    pub fn video_codec_label(&self) -> Option<String> {
        let raw = self.vcodec.as_deref()?;
        Some(short_video_codec(raw))
    }

    pub fn audio_codec_label(&self) -> Option<String> {
        let raw = self.acodec.as_deref()?;
        Some(short_audio_codec(raw))
    }

    pub fn resolution_label(&self) -> String {
        match (self.width, self.height) {
            (_, Some(height)) if height > 0 => {
                if height >= 4320 {
                    "8K".into()
                } else {
                    format!("{height}p")
                }
            }
            (Some(width), _) if width > 0 => format!("{width}px"),
            _ => "audio".into(),
        }
    }
}

pub fn short_video_codec(raw: &str) -> String {
    let lowered = raw.to_ascii_lowercase();
    if lowered.starts_with("av01") || lowered.contains("av1") {
        "AV1".into()
    } else if lowered.starts_with("vp9") || lowered.starts_with("vp09") {
        "VP9".into()
    } else if lowered.starts_with("vp8") {
        "VP8".into()
    } else if lowered.starts_with("avc") || lowered.starts_with("h264") {
        "H.264".into()
    } else if lowered.starts_with("hev") || lowered.starts_with("h265") {
        "H.265".into()
    } else if lowered == "none" || lowered.is_empty() {
        "—".into()
    } else {
        raw.split('.').next().unwrap_or(raw).to_ascii_uppercase()
    }
}

pub fn short_audio_codec(raw: &str) -> String {
    let lowered = raw.to_ascii_lowercase();
    if lowered.starts_with("opus") {
        "Opus".into()
    } else if lowered.starts_with("mp4a") || lowered.contains("aac") {
        "AAC".into()
    } else if lowered.starts_with("vorbis") {
        "Vorbis".into()
    } else if lowered.starts_with("ec-3") || lowered.starts_with("eac3") {
        "E-AC3".into()
    } else if lowered.starts_with("ac-3") || lowered.starts_with("ac3") {
        "AC-3".into()
    } else if lowered.starts_with("flac") {
        "FLAC".into()
    } else if lowered.starts_with("mp3") {
        "MP3".into()
    } else if lowered == "none" || lowered.is_empty() {
        "—".into()
    } else {
        raw.split('.').next().unwrap_or(raw).to_ascii_uppercase()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleInfo {
    pub language: String,
    pub name: Option<String>,
    pub formats: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChapterInfo {
    pub title: String,
    pub start_time: f64,
    pub end_time: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FormatOptionKind {
    /// A ready-made file that already carries both streams.
    Progressive,
    /// A video stream that must be paired with a separate audio stream.
    VideoWithAudio,
    VideoOnly,
    AudioOnly,
}

/// One row of the format selector: either a muxed format or a video+audio pair.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatOption {
    pub id: String,
    pub kind: FormatOptionKind,
    pub label: String,
    pub detail: String,
    pub height: Option<u32>,
    pub width: Option<u32>,
    pub fps: Option<f64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub container: String,
    pub hdr: bool,
    pub dynamic_range: Option<String>,
    pub video_format_id: Option<String>,
    pub audio_format_id: Option<String>,
    pub single_format_id: Option<String>,
    pub bitrate_mbps: Option<f64>,
    pub size_bytes: Option<u64>,
    pub audio_bitrate: Option<f64>,
    pub recommended: bool,
    pub available: bool,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistEntry {
    pub id: String,
    pub title: String,
    pub url: String,
    pub duration: Option<f64>,
    pub thumbnail: Option<String>,
    pub uploader: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaProbe {
    pub kind: MediaKind,
    pub id: String,
    pub title: String,
    pub webpage_url: String,
    pub uploader: Option<String>,
    pub channel_url: Option<String>,
    pub duration: Option<f64>,
    pub description: Option<String>,
    pub upload_date: Option<String>,
    pub view_count: Option<u64>,
    pub like_count: Option<u64>,
    pub is_live: bool,
    pub was_live: bool,
    pub extractor: Option<String>,
    pub thumbnail: Option<String>,
    pub thumbnails: Vec<ThumbnailInfo>,
    pub formats: Vec<FormatInfo>,
    pub subtitles: Vec<SubtitleInfo>,
    pub automatic_captions: Vec<SubtitleInfo>,
    pub chapters: Vec<ChapterInfo>,
    pub entries: Vec<PlaylistEntry>,
    pub playlist_count: Option<u64>,
    pub options: Vec<FormatOption>,
}

impl Default for MediaKind {
    fn default() -> Self {
        Self::Video
    }
}

/// Human readable "1:02:03" / "12:34" duration.
pub fn format_duration(seconds: Option<f64>) -> String {
    let total = match seconds {
        Some(value) if value.is_finite() && value >= 0.0 => value.round() as u64,
        _ => return "—".into(),
    };
    let hours = total / 3600;
    let minutes = (total % 3600) / 60;
    let secs = total % 60;
    if hours > 0 {
        format!("{hours}:{minutes:02}:{secs:02}")
    } else {
        format!("{minutes}:{secs:02}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn format(id: &str, vcodec: &str, acodec: &str, height: Option<u32>) -> FormatInfo {
        FormatInfo {
            format_id: id.into(),
            ext: "webm".into(),
            vcodec: Some(vcodec.into()),
            acodec: Some(acodec.into()),
            height,
            ..Default::default()
        }
    }

    #[test]
    fn stream_kinds_are_classified() {
        let progressive = format("18", "avc1.42001E", "mp4a.40.2", Some(360));
        assert!(progressive.is_progressive());
        assert!(progressive.has_video() && progressive.has_audio());

        let video_only = format("137", "avc1.640028", "none", Some(1080));
        assert!(video_only.has_video());
        assert!(!video_only.has_audio());
        assert!(!video_only.is_progressive());

        let audio_only = format("251", "none", "opus", None);
        assert!(audio_only.has_audio());
        assert!(!audio_only.has_video());
        assert_eq!(audio_only.resolution_label(), "audio");
    }

    #[test]
    fn codec_labels_are_human_readable() {
        assert_eq!(short_video_codec("av01.0.08M.08"), "AV1");
        assert_eq!(short_video_codec("vp09.00.10.08"), "VP9");
        assert_eq!(short_video_codec("avc1.640028"), "H.264");
        assert_eq!(short_audio_codec("opus"), "Opus");
        assert_eq!(short_audio_codec("mp4a.40.2"), "AAC");
        assert_eq!(short_audio_codec("none"), "—");
    }

    #[test]
    fn hdr_detection_covers_common_ranges() {
        let mut info = format("337", "vp09.02.51.10.01.09.16.09.00", "none", Some(2160));
        info.dynamic_range = Some("HDR10".into());
        assert!(info.is_hdr());
        info.dynamic_range = Some("SDR".into());
        assert!(!info.is_hdr());
    }

    #[test]
    fn durations_render_compactly() {
        assert_eq!(format_duration(Some(59.0)), "0:59");
        assert_eq!(format_duration(Some(754.0)), "12:34");
        assert_eq!(format_duration(Some(3723.0)), "1:02:03");
        assert_eq!(format_duration(None), "—");
    }
}
