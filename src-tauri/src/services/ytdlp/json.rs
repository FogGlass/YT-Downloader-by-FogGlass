//! Parsing `yt-dlp --dump-single-json` and deriving the format selector's rows.
//!
//! The extractor payload differs between sites and versions, so every field is read
//! defensively; a missing key degrades one row of the UI instead of failing the probe.

use serde_json::Value;

use crate::models::media::{
    ChapterInfo, FormatInfo, FormatOption, FormatOptionKind, MediaKind, MediaProbe, PlaylistEntry,
    SubtitleInfo, ThumbnailInfo,
};
use crate::models::settings::{AppSettings, AudioCodecPreference, CodecPreference};

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty() && *item != "NA")
        .map(str::to_string)
}

fn number(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(|item| match item {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    })
}

fn integer(value: &Value, key: &str) -> Option<u64> {
    number(value, key).map(|value| value.max(0.0) as u64)
}

fn unsigned(value: &Value, key: &str) -> Option<u32> {
    integer(value, key).map(|value| value as u32)
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Probe parsing
// ---------------------------------------------------------------------------

pub fn parse_probe(payload: &Value, request_url: &str) -> MediaProbe {
    let entries = parse_entries(payload);
    let formats: Vec<FormatInfo> = payload
        .get("formats")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(parse_format).collect())
        .unwrap_or_default();

    let declared_kind = text(payload, "_type").unwrap_or_default();
    let is_playlist = matches!(declared_kind.as_str(), "playlist" | "multi_video")
        || (!entries.is_empty() && formats.is_empty());

    let kind = if is_playlist {
        if request_url.contains("/@") || request_url.contains("/channel/") || request_url.contains("/c/") {
            MediaKind::Channel
        } else {
            MediaKind::Playlist
        }
    } else {
        MediaKind::Video
    };

    let thumbnails = parse_thumbnails(payload);
    let thumbnail = text(payload, "thumbnail").or_else(|| {
        thumbnails
            .iter()
            .max_by_key(|item| item.preference.unwrap_or(0) + item.width.unwrap_or(0) as i64)
            .map(|item| item.url.clone())
    });

    MediaProbe {
        kind,
        id: text(payload, "id").unwrap_or_default(),
        title: text(payload, "title")
            .or_else(|| text(payload, "playlist_title"))
            .unwrap_or_else(|| "未命名".into()),
        webpage_url: text(payload, "webpage_url").unwrap_or_else(|| request_url.to_string()),
        uploader: text(payload, "uploader").or_else(|| text(payload, "channel")),
        channel_url: text(payload, "channel_url").or_else(|| text(payload, "uploader_url")),
        duration: number(payload, "duration"),
        description: text(payload, "description"),
        upload_date: text(payload, "upload_date"),
        view_count: integer(payload, "view_count"),
        like_count: integer(payload, "like_count"),
        is_live: flag(payload, "is_live"),
        was_live: flag(payload, "was_live"),
        extractor: text(payload, "extractor_key").or_else(|| text(payload, "extractor")),
        thumbnail,
        thumbnails,
        options: build_format_options(&formats, &MediaProbe::default_settings_view()),
        formats,
        subtitles: parse_subtitles(payload, "subtitles"),
        automatic_captions: parse_subtitles(payload, "automatic_captions"),
        chapters: parse_chapters(payload),
        playlist_count: integer(payload, "playlist_count")
            .or_else(|| integer(payload, "n_entries"))
            .or(if entries.is_empty() { None } else { Some(entries.len() as u64) }),
        entries,
    }
}

/// A settings-free view used when the caller has no settings to hand.
impl MediaProbe {
    fn default_settings_view() -> AppSettings {
        AppSettings::default()
    }
}

fn parse_format(value: &Value) -> FormatInfo {
    FormatInfo {
        format_id: text(value, "format_id").unwrap_or_default(),
        ext: text(value, "ext").unwrap_or_else(|| "bin".into()),
        vcodec: text(value, "vcodec"),
        acodec: text(value, "acodec"),
        width: unsigned(value, "width"),
        height: unsigned(value, "height"),
        fps: number(value, "fps"),
        dynamic_range: text(value, "dynamic_range"),
        tbr: number(value, "tbr"),
        vbr: number(value, "vbr"),
        abr: number(value, "abr"),
        audio_channels: unsigned(value, "audio_channels"),
        audio_sample_rate: unsigned(value, "asr"),
        filesize: integer(value, "filesize"),
        filesize_approx: integer(value, "filesize_approx"),
        protocol: text(value, "protocol"),
        language: text(value, "language"),
        format_note: text(value, "format_note"),
        quality: number(value, "quality"),
    }
}

fn parse_thumbnails(payload: &Value) -> Vec<ThumbnailInfo> {
    payload
        .get("thumbnails")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let url = text(item, "url")?;
                    Some(ThumbnailInfo {
                        url,
                        width: unsigned(item, "width"),
                        height: unsigned(item, "height"),
                        preference: item.get("preference").and_then(Value::as_i64),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_subtitles(payload: &Value, key: &str) -> Vec<SubtitleInfo> {
    let Some(map) = payload.get(key).and_then(Value::as_object) else {
        return Vec::new();
    };

    let mut subtitles: Vec<SubtitleInfo> = map
        .iter()
        .map(|(language, formats)| SubtitleInfo {
            language: language.clone(),
            name: formats
                .as_array()
                .and_then(|items| items.first())
                .and_then(|item| text(item, "name")),
            formats: formats
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| text(item, "ext"))
                        .collect()
                })
                .unwrap_or_default(),
        })
        .collect();

    // Prefer the familiar language codes first so the UI list reads naturally.
    subtitles.sort_by_key(|item| {
        let rank = match item.language.as_str() {
            "zh-Hans" | "zh-CN" => 0,
            "zh-Hant" | "zh-TW" => 1,
            "en" => 2,
            _ => 10,
        };
        (rank, item.language.clone())
    });
    subtitles
}

fn parse_chapters(payload: &Value) -> Vec<ChapterInfo> {
    payload
        .get("chapters")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(ChapterInfo {
                        title: text(item, "title").unwrap_or_else(|| "章节".into()),
                        start_time: number(item, "start_time").unwrap_or(0.0),
                        end_time: number(item, "end_time"),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_entries(payload: &Value) -> Vec<PlaylistEntry> {
    payload
        .get("entries")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    if item.is_null() {
                        return None;
                    }
                    let id = text(item, "id").unwrap_or_default();
                    let url = text(item, "webpage_url")
                        .or_else(|| text(item, "url"))
                        .or_else(|| {
                            if id.is_empty() {
                                None
                            } else {
                                Some(format!("https://www.youtube.com/watch?v={id}"))
                            }
                        })?;

                    Some(PlaylistEntry {
                        id,
                        title: text(item, "title").unwrap_or_else(|| "未命名条目".into()),
                        url,
                        duration: number(item, "duration"),
                        thumbnail: text(item, "thumbnail"),
                        uploader: text(item, "uploader").or_else(|| text(item, "channel")),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Format option derivation
// ---------------------------------------------------------------------------

/// Rank a video codec against the user's preference (lower is better).
fn codec_rank(codec: &Option<String>, preference: CodecPreference) -> u8 {
    let label = codec.clone().unwrap_or_default();
    match preference {
        CodecPreference::Av1 => match label.as_str() {
            "AV1" => 0,
            "VP9" => 1,
            _ => 2,
        },
        CodecPreference::Vp9 => match label.as_str() {
            "VP9" => 0,
            "AV1" => 1,
            _ => 2,
        },
        CodecPreference::H264 => match label.as_str() {
            "H.264" => 0,
            "VP9" => 1,
            _ => 2,
        },
        // Automatic keeps the project's documented default: WebM + Opus, which
        // means VP9 for video. AV1 stores the same quality in fewer bytes but its
        // stream arrives in an MP4 container, so it is offered as an explicit
        // choice rather than silently replacing the WebM default.
        CodecPreference::Auto => match label.as_str() {
            "VP9" => 0,
            "AV1" => 1,
            "H.264" => 2,
            _ => 3,
        },
    }
}

fn audio_rank(codec: &Option<String>, prefer_aac: bool) -> u8 {
    let label = codec.clone().unwrap_or_default();
    if prefer_aac {
        match label.as_str() {
            "AAC" => 0,
            "Opus" => 1,
            _ => 2,
        }
    } else {
        match label.as_str() {
            "Opus" => 0,
            "AAC" => 1,
            _ => 2,
        }
    }
}

/// Which audio family should be paired with the selected video.
///
/// The automatic answer follows the video choice: H.264 means "maximum
/// compatibility", and the only combination every player understands is MP4 + AAC.
fn prefer_aac(settings: &AppSettings) -> bool {
    match settings.youtube.audio_codec_preference {
        AudioCodecPreference::Aac => true,
        AudioCodecPreference::Opus => false,
        AudioCodecPreference::Auto => {
            settings.youtube.video_codec_preference == CodecPreference::H264
        }
    }
}

fn container_for(video_ext: &str, audio_ext: &str) -> String {
    let video = video_ext.to_ascii_lowercase();
    let audio = audio_ext.to_ascii_lowercase();
    if video.starts_with("webm") && (audio.starts_with("webm") || audio.starts_with("opus")) {
        "webm".into()
    } else if (video.starts_with("mp4") || video.starts_with("m4v"))
        && (audio.starts_with("m4a") || audio.starts_with("mp4") || audio.starts_with("aac"))
    {
        "mp4".into()
    } else {
        "mkv".into()
    }
}

fn human_bitrate(mbps: Option<f64>) -> Option<String> {
    mbps.filter(|value| *value > 0.0)
        .map(|value| format!("{value:.1} Mbps"))
}

/// yt-dlp reports `tbr`/`abr` in kbps; the UI shows Mbps.
fn kbps_to_mbps(value: Option<f64>) -> Option<f64> {
    value.filter(|value| *value > 0.0).map(|value| value / 1000.0)
}

/// Build the selector rows: video+audio pairs, muxed formats and audio-only tracks.
pub fn build_format_options(formats: &[FormatInfo], settings: &AppSettings) -> Vec<FormatOption> {
    let want_aac = prefer_aac(settings);

    let progressive: Vec<&FormatInfo> = formats
        .iter()
        .filter(|item| item.is_progressive() && !item.is_drm())
        .collect();
    let mut videos: Vec<&FormatInfo> = formats
        .iter()
        .filter(|item| item.has_video() && !item.has_audio() && !item.is_drm())
        .collect();
    let mut audios: Vec<&FormatInfo> = formats
        .iter()
        .filter(|item| item.has_audio() && !item.has_video() && !item.is_drm())
        .collect();

    // Deduplicate video streams: the same resolution/codec often appears several
    // times (different containers or fragment protocols). Keep the best bitrate.
    videos.sort_by(|left, right| {
        right
            .tbr
            .unwrap_or(0.0)
            .partial_cmp(&left.tbr.unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut seen_video: Vec<(u32, u32, String, bool, String)> = Vec::new();
    videos.retain(|item| {
        let key = (
            item.height.unwrap_or(0),
            item.fps.unwrap_or(0.0).round() as u32,
            item.video_codec_label().unwrap_or_default(),
            item.is_hdr(),
            item.ext.to_ascii_lowercase(),
        );
        if seen_video.contains(&key) {
            false
        } else {
            seen_video.push(key);
            true
        }
    });

    // Audio: keep the best track for each codec family.
    audios.sort_by(|left, right| {
        right
            .abr
            .unwrap_or(0.0)
            .partial_cmp(&left.abr.unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut seen_audio: Vec<String> = Vec::new();
    audios.retain(|item| {
        let key = item.audio_codec_label().unwrap_or_default();
        if seen_audio.contains(&key) {
            false
        } else {
            seen_audio.push(key);
            true
        }
    });

    let primary_audio = audios
        .iter()
        .copied()
        .min_by_key(|item| audio_rank(&item.audio_codec_label(), want_aac));

    let mut options: Vec<FormatOption> = Vec::new();

    for video in &videos {
        let video_codec = video.video_codec_label();
        let (audio, container) = match primary_audio {
            Some(audio) => {
                let container = container_for(&video.ext, &audio.ext);
                (Some(audio), container)
            }
            None => (None, video.ext.to_ascii_lowercase()),
        };

        let total_kbps = Some(video.tbr.unwrap_or(0.0) + audio.and_then(|item| item.abr).unwrap_or(0.0))
            .filter(|value| *value > 0.0);
        let total_mbps = kbps_to_mbps(total_kbps);
        let total_size = video.size_estimate().map(|size| {
            size + audio.and_then(|item| item.size_estimate()).unwrap_or(0)
        });

        let mut detail_parts: Vec<String> = Vec::new();
        if let Some(codec) = &video_codec {
            detail_parts.push(codec.clone());
        }
        if let Some(codec) = audio.and_then(|item| item.audio_codec_label()) {
            detail_parts.push(codec);
        } else {
            detail_parts.push("无音轨".into());
        }
        if let Some(bitrate) = human_bitrate(total_mbps) {
            detail_parts.push(bitrate);
        }
        if video.is_hdr() {
            detail_parts.push("HDR".into());
        }

        options.push(FormatOption {
            id: match audio {
                Some(audio) => format!("{}+{}", video.format_id, audio.format_id),
                None => video.format_id.clone(),
            },
            kind: if audio.is_some() {
                FormatOptionKind::VideoWithAudio
            } else {
                FormatOptionKind::VideoOnly
            },
            label: resolution_label(video),
            detail: detail_parts.join(" · "),
            height: video.height,
            width: video.width,
            fps: video.fps,
            video_codec,
            audio_codec: audio.and_then(|item| item.audio_codec_label()),
            container,
            hdr: video.is_hdr(),
            dynamic_range: video.dynamic_range.clone(),
            video_format_id: Some(video.format_id.clone()),
            audio_format_id: audio.map(|item| item.format_id.clone()),
            single_format_id: None,
            bitrate_mbps: total_mbps,
            size_bytes: total_size,
            audio_bitrate: audio.and_then(|item| item.abr),
            recommended: false,
            available: true,
            note: video.format_note.clone(),
        });
    }

    for format in &progressive {
        let detail = [
            format.video_codec_label(),
            format.audio_codec_label(),
            human_bitrate(kbps_to_mbps(format.tbr)),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<String>>()
        .join(" · ");

        options.push(FormatOption {
            id: format.format_id.clone(),
            kind: FormatOptionKind::Progressive,
            label: resolution_label(format),
            detail,
            height: format.height,
            width: format.width,
            fps: format.fps,
            video_codec: format.video_codec_label(),
            audio_codec: format.audio_codec_label(),
            container: format.ext.to_ascii_lowercase(),
            hdr: format.is_hdr(),
            dynamic_range: format.dynamic_range.clone(),
            video_format_id: None,
            audio_format_id: None,
            single_format_id: Some(format.format_id.clone()),
            bitrate_mbps: format.tbr.map(|value| value / 1000.0),
            size_bytes: format.size_estimate(),
            audio_bitrate: format.abr,
            recommended: false,
            available: true,
            note: Some("单文件".into()),
        });
    }

    for audio in &audios {
        let mut detail_parts = Vec::new();
        if let Some(codec) = audio.audio_codec_label() {
            detail_parts.push(codec);
        }
        if let Some(bitrate) = audio.abr.filter(|value| *value > 0.0) {
            detail_parts.push(format!("{:.0} kbps", bitrate));
        }
        if let Some(channels) = audio.audio_channels {
            detail_parts.push(format!("{channels} 声道"));
        }

        let mut container = audio.ext.to_ascii_lowercase();
        if container == "m4a" {
            container = "mp4".into();
        }

        options.push(FormatOption {
            id: audio.format_id.clone(),
            kind: FormatOptionKind::AudioOnly,
            label: audio
                .audio_codec_label()
                .unwrap_or_else(|| "音频".into()),
            detail: detail_parts.join(" · "),
            height: None,
            width: None,
            fps: None,
            video_codec: None,
            audio_codec: audio.audio_codec_label(),
            container,
            hdr: false,
            dynamic_range: None,
            video_format_id: None,
            audio_format_id: None,
            single_format_id: Some(audio.format_id.clone()),
            bitrate_mbps: None,
            size_bytes: audio.size_estimate(),
            audio_bitrate: audio.abr,
            recommended: false,
            available: true,
            note: Some("仅音频".into()),
        });
    }

    sort_options(&mut options, settings);
    mark_recommended(&mut options, settings);
    options
}

fn resolution_label(format: &FormatInfo) -> String {
    let base = match format.height {
        Some(height) if height >= 4320 => "8K".to_string(),
        Some(height) if height > 0 => format!("{height}p"),
        _ => "视频".to_string(),
    };
    match format.fps {
        Some(fps) if fps >= 50.0 => format!("{base}{}", fps.round() as u32),
        _ => base,
    }
}

fn sort_options(options: &mut [FormatOption], settings: &AppSettings) {
    let preference = settings.youtube.video_codec_preference;
    let prefer_fps = settings.youtube.prefer_60fps;

    options.sort_by(|left, right| {
        let kind_rank = |kind: FormatOptionKind| match kind {
            FormatOptionKind::VideoWithAudio => 0,
            FormatOptionKind::Progressive => 1,
            FormatOptionKind::VideoOnly => 2,
            FormatOptionKind::AudioOnly => 3,
        };

        kind_rank(left.kind)
            .cmp(&kind_rank(right.kind))
            .then_with(|| {
                right
                    .height
                    .unwrap_or(0)
                    .cmp(&left.height.unwrap_or(0))
            })
            .then_with(|| {
                if prefer_fps {
                    right
                        .fps
                        .unwrap_or(0.0)
                        .partial_cmp(&left.fps.unwrap_or(0.0))
                        .unwrap_or(std::cmp::Ordering::Equal)
                } else {
                    std::cmp::Ordering::Equal
                }
            })
            .then_with(|| {
                codec_rank(&left.video_codec, preference)
                    .cmp(&codec_rank(&right.video_codec, preference))
            })
            .then_with(|| {
                right
                    .bitrate_mbps
                    .unwrap_or(0.0)
                    .partial_cmp(&left.bitrate_mbps.unwrap_or(0.0))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
}

/// Flag the single row the "smart default" should start on.
///
/// `options` is already ordered best-first (muxed video rows by descending height,
/// then muxed single files, then audio), so the first row that satisfies the height
/// limit is the recommendation.
fn mark_recommended(options: &mut [FormatOption], settings: &AppSettings) {
    let max_height = settings
        .youtube
        .max_height
        .trim()
        .parse::<u32>()
        .ok()
        .filter(|value| *value > 0);

    let is_video_row = |option: &FormatOption| {
        matches!(
            option.kind,
            FormatOptionKind::VideoWithAudio | FormatOptionKind::Progressive
        )
    };
    let within_limit = |option: &FormatOption| match max_height {
        Some(limit) => option.height.unwrap_or(0) <= limit,
        None => true,
    };

    let candidate = options
        .iter()
        .position(|option| is_video_row(option) && within_limit(option))
        .or_else(|| options.iter().position(is_video_row))
        .or_else(|| options.iter().position(|option| option.kind == FormatOptionKind::AudioOnly));

    if let Some(index) = candidate {
        if let Some(option) = options.get_mut(index) {
            option.recommended = true;
        }
    }
}

/// Turn a selection into a yt-dlp `-f` expression.
pub fn format_expression(video: Option<&str>, audio: Option<&str>, single: Option<&str>) -> String {
    match (single, video, audio) {
        (Some(single), _, _) => single.to_string(),
        (None, Some(video), Some(audio)) => format!("{video}+{audio}"),
        (None, Some(video), None) => video.to_string(),
        (None, None, Some(audio)) => audio.to_string(),
        _ => "bv*+ba/b".to_string(),
    }
}

/// Convenience for callers that only hold string slices from the UI.
pub fn format_expression_from_strings(values: [Option<&str>; 3]) -> String {
    format_expression(values[0], values[1], values[2])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings() -> AppSettings {
        AppSettings::default()
    }

    fn sample_payload() -> Value {
        json!({
            "_type": "video",
            "id": "aqz-KE-bpKQ",
            "title": "Big Buck Bunny",
            "webpage_url": "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
            "uploader": "Blender",
            "duration": 635.0,
            "thumbnail": "https://i.ytimg.com/vi/aqz-KE-bpKQ/maxresdefault.jpg",
            "view_count": 1234567,
            "is_live": false,
            "extractor_key": "Youtube",
            "thumbnails": [
                { "url": "https://i.ytimg.com/vi/aqz-KE-bpKQ/hq720.jpg", "width": 1280, "height": 720, "preference": 1 }
            ],
            "chapters": [
                { "title": "Intro", "start_time": 0.0, "end_time": 30.0 }
            ],
            "subtitles": {
                "en": [ { "ext": "vtt", "name": "English" } ],
                "zh-Hans": [ { "ext": "vtt" } ]
            },
            "automatic_captions": {
                "en": [ { "ext": "vtt" } ]
            },
            "formats": [
                { "format_id": "137", "ext": "mp4", "vcodec": "avc1.640028", "acodec": "none", "width": 1920, "height": 1080, "fps": 30, "tbr": 4416.0, "filesize": 100000000, "dynamic_range": "SDR" },
                { "format_id": "248", "ext": "webm", "vcodec": "vp09.00.10.08", "acodec": "none", "width": 1920, "height": 1080, "fps": 30, "tbr": 3200.0, "filesize": 80000000 },
                { "format_id": "399", "ext": "mp4", "vcodec": "av01.0.08M.08", "acodec": "none", "width": 1920, "height": 1080, "fps": 30, "tbr": 2600.0, "filesize": 70000000 },
                { "format_id": "251", "ext": "webm", "vcodec": "none", "acodec": "opus", "abr": 130.0, "audio_channels": 2, "filesize": 10000000 },
                { "format_id": "140", "ext": "m4a", "vcodec": "none", "acodec": "mp4a.40.2", "abr": 128.0, "audio_channels": 2, "filesize": 9800000 },
                { "format_id": "18", "ext": "mp4", "vcodec": "avc1.42001E", "acodec": "mp4a.40.2", "width": 640, "height": 360, "fps": 30, "tbr": 700.0, "filesize": 20000000 }
            ]
        })
    }

    #[test]
    fn probe_parsing_keeps_the_essentials() {
        let probe = parse_probe(&sample_payload(), "https://www.youtube.com/watch?v=aqz-KE-bpKQ");
        assert_eq!(probe.kind, MediaKind::Video);
        assert_eq!(probe.title, "Big Buck Bunny");
        assert_eq!(probe.uploader.as_deref(), Some("Blender"));
        assert_eq!(probe.duration, Some(635.0));
        assert_eq!(probe.formats.len(), 6);
        assert_eq!(probe.chapters.len(), 1);
        // Subtitles are ordered with the familiar languages first.
        assert_eq!(probe.subtitles[0].language, "zh-Hans");
        assert!(probe.thumbnail.unwrap().contains("maxresdefault"));
    }

    #[test]
    fn video_and_audio_streams_are_paired() {
        let probe = parse_probe(&sample_payload(), "u");
        let pairs: Vec<&FormatOption> = probe
            .options
            .iter()
            .filter(|option| option.kind == FormatOptionKind::VideoWithAudio)
            .collect();
        assert_eq!(pairs.len(), 3, "one row per distinct 1080p stream");

        // Default preference is WebM + Opus, i.e. the VP9 stream.
        let vp9 = pairs
            .iter()
            .find(|option| option.video_codec.as_deref() == Some("VP9"))
            .expect("VP9 row");
        assert_eq!(vp9.audio_codec.as_deref(), Some("Opus"));
        assert_eq!(vp9.container, "webm");
        assert_eq!(vp9.label, "1080p");
        assert_eq!(vp9.video_format_id.as_deref(), Some("248"));
        assert_eq!(vp9.audio_format_id.as_deref(), Some("251"));
        // 3.2 Mbps video + 0.13 Mbps audio
        assert!((vp9.bitrate_mbps.unwrap() - 3.33).abs() < 0.01);
        // yt-dlp reports kbps; the label must not claim those are Mbps.
        assert!(
            vp9.detail.contains("3.3 Mbps"),
            "detail should render Mbps, got {}",
            vp9.detail
        );
        assert_eq!(vp9.size_bytes, Some(90_000_000));

        // An AV1 stream arrives in an MP4 container, so pairing it with Opus can
        // only be expressed as Matroska.
        let av1 = pairs
            .iter()
            .find(|option| option.video_codec.as_deref() == Some("AV1"))
            .expect("AV1 row");
        assert_eq!(av1.container, "mkv");
    }

    #[test]
    fn muxed_and_audio_rows_are_present() {
        let probe = parse_probe(&sample_payload(), "u");
        assert!(probe
            .options
            .iter()
            .any(|option| option.kind == FormatOptionKind::Progressive && option.label == "360p"));
        let audio_rows: Vec<&FormatOption> = probe
            .options
            .iter()
            .filter(|option| option.kind == FormatOptionKind::AudioOnly)
            .collect();
        assert_eq!(audio_rows.len(), 2);
        assert!(audio_rows.iter().any(|row| row.label == "Opus"));
        assert!(audio_rows.iter().any(|row| row.label == "AAC"));
    }

    #[test]
    fn the_recommended_row_is_the_best_available_pair() {
        let probe = parse_probe(&sample_payload(), "u");
        let recommended = probe
            .options
            .iter()
            .find(|option| option.recommended)
            .expect("a recommended row");
        assert_eq!(recommended.height, Some(1080));
        // Automatic preference ranks the WebM/Opus pair first.
        assert_eq!(recommended.video_codec.as_deref(), Some("VP9"));
        assert_eq!(recommended.container, "webm");
    }

    #[test]
    fn av1_can_be_chosen_explicitly() {
        let mut settings = settings();
        settings.youtube.video_codec_preference = CodecPreference::Av1;
        let formats: Vec<FormatInfo> = sample_payload()["formats"]
            .as_array()
            .unwrap()
            .iter()
            .map(parse_format)
            .collect();
        let options = build_format_options(&formats, &settings);
        let recommended = options.iter().find(|option| option.recommended).unwrap();
        assert_eq!(recommended.video_codec.as_deref(), Some("AV1"));
    }

    #[test]
    fn height_limit_changes_the_recommendation() {
        let mut settings = settings();
        settings.youtube.max_height = "720".into();
        let payload = json!({
            "formats": [
                { "format_id": "137", "ext": "mp4", "vcodec": "avc1", "acodec": "none", "height": 1080, "tbr": 4000.0 },
                { "format_id": "136", "ext": "mp4", "vcodec": "avc1", "acodec": "none", "height": 720, "tbr": 2000.0 },
                { "format_id": "251", "ext": "webm", "vcodec": "none", "acodec": "opus", "abr": 130.0 }
            ]
        });
        let formats: Vec<FormatInfo> = payload["formats"]
            .as_array()
            .unwrap()
            .iter()
            .map(parse_format)
            .collect();
        let options = build_format_options(&formats, &settings);
        let recommended = options.iter().find(|option| option.recommended).unwrap();
        assert_eq!(recommended.height, Some(720));
    }

    #[test]
    fn explicit_codec_preference_is_respected() {
        let mut settings = settings();
        settings.youtube.video_codec_preference = CodecPreference::H264;
        let formats: Vec<FormatInfo> = sample_payload()["formats"]
            .as_array()
            .unwrap()
            .iter()
            .map(parse_format)
            .collect();
        let options = build_format_options(&formats, &settings);
        let recommended = options.iter().find(|option| option.recommended).unwrap();
        assert_eq!(recommended.video_codec.as_deref(), Some("H.264"));
        assert_eq!(recommended.container, "mp4");
    }

    #[test]
    fn implicit_playlists_are_detected() {
        let payload = json!({
            "_type": "playlist",
            "id": "PL123",
            "title": "Some playlist",
            "playlist_count": 3,
            "entries": [
                { "id": "a", "title": "One", "duration": 10.0 },
                { "id": "b", "title": "Two", "url": "https://www.youtube.com/watch?v=b" },
                { "id": "c", "title": "Three" }
            ]
        });
        let probe = parse_probe(&payload, "https://www.youtube.com/playlist?list=PL123");
        assert_eq!(probe.kind, MediaKind::Playlist);
        assert_eq!(probe.entries.len(), 3);
        assert_eq!(probe.playlist_count, Some(3));
        assert!(probe.entries[0].url.contains("watch?v=a"));
        assert_eq!(probe.entries[1].url, "https://www.youtube.com/watch?v=b");
    }

    #[test]
    fn channel_urls_are_recognised() {
        let payload = json!({ "_type": "playlist", "entries": [ { "id": "x", "title": "x" } ] });
        let probe = parse_probe(&payload, "https://www.youtube.com/@SomeChannel/videos");
        assert_eq!(probe.kind, MediaKind::Channel);
    }

    #[test]
    fn drm_formats_are_never_offered() {
        let payload = json!({
            "formats": [
                { "format_id": "drm-1", "ext": "mp4", "vcodec": "avc1", "acodec": "none", "height": 1080 },
                { "format_id": "137", "ext": "mp4", "vcodec": "avc1", "acodec": "none", "height": 1080 },
                { "format_id": "251", "ext": "webm", "vcodec": "none", "acodec": "opus", "abr": 130.0 }
            ]
        });
        let formats: Vec<FormatInfo> = payload["formats"]
            .as_array()
            .unwrap()
            .iter()
            .map(parse_format)
            .collect();
        let options = build_format_options(&formats, &AppSettings::default());
        assert!(options
            .iter()
            .all(|option| option.video_format_id.as_deref() != Some("drm-1")));
    }

    #[test]
    fn format_expressions_match_the_selection() {
        assert_eq!(format_expression(Some("137"), Some("251"), None), "137+251");
        assert_eq!(format_expression(None, None, Some("18")), "18");
        assert_eq!(format_expression(Some("137"), None, None), "137");
        assert_eq!(format_expression(None, None, None), "bv*+ba/b");
    }

    #[test]
    fn missing_fields_do_not_break_parsing() {
        let probe = parse_probe(&json!({ "id": "x" }), "https://example.com/x");
        assert_eq!(probe.title, "未命名");
        assert!(probe.formats.is_empty());
        assert!(probe.options.is_empty());
        assert_eq!(probe.webpage_url, "https://example.com/x");
    }
}
