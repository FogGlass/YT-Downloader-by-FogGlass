//! FFmpeg integration: muxing the two downloaded streams, embedding metadata and
//! verifying the result.
//!
//! Muxing is always a stream copy. Nothing here re-encodes, so a download keeps
//! exactly the bytes YouTube served.

use std::path::{Path, PathBuf};

use crate::core::error::{AppError, AppResult};
use crate::models::media::ChapterInfo;
use crate::models::settings::AppSettings;
use crate::runtime::ToolSet;
use crate::log_debug;

/// Everything FFmpeg needs to produce the final file.
#[derive(Debug, Clone)]
pub struct MergePlan {
    pub video: PathBuf,
    pub audio: PathBuf,
    pub output: PathBuf,
    pub container: String,
    pub thumbnail: Option<PathBuf>,
    pub metadata_file: Option<PathBuf>,
    pub tags: Vec<(String, String)>,
    pub chapters: Vec<ChapterInfo>,
    pub duration: Option<f64>,
}

/// Build the argument vector for the mux step.
pub fn merge_args(settings: &AppSettings, tools: &ToolSet, plan: &MergePlan) -> Vec<String> {
    let mut args = vec![
        "-hide_banner".to_string(),
        "-nostdin".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
        "-progress".to_string(),
        "pipe:1".to_string(),
        "-nostats".to_string(),
        "-y".to_string(),
    ];

    // Input 0: video, input 1: audio. Optional inputs follow in a fixed order so the
    // stream indices below stay predictable.
    args.push("-i".into());
    args.push(plan.video.to_string_lossy().to_string());
    args.push("-i".into());
    args.push(plan.audio.to_string_lossy().to_string());

    let mut next_index = 2usize;
    let thumbnail_index = plan.thumbnail.as_ref().map(|path| {
        args.push("-i".into());
        args.push(path.to_string_lossy().to_string());
        let index = next_index;
        next_index += 1;
        index
    });
    let metadata_index = plan.metadata_file.as_ref().map(|path| {
        args.push("-i".into());
        args.push(path.to_string_lossy().to_string());
        let index = next_index;
        index
    });

    args.push("-map".into());
    args.push("0:v:0".into());
    args.push("-map".into());
    args.push("1:a:0".into());

    // Cover art: a still image attached as a video stream.
    if let Some(index) = thumbnail_index {
        if plan.container != "webm" {
            args.push("-map".into());
            args.push(format!("{index}:v:0"));
            args.push("-c:v:1".into());
            args.push("copy".into());
            args.push("-disposition:v:1".into());
            args.push("attached_pic".into());
        }
    }

    args.push("-c".into());
    args.push("copy".into());

    if let Some(index) = metadata_index {
        args.push("-map_metadata".into());
        args.push(index.to_string());
        if !plan.chapters.is_empty() {
            args.push("-map_chapters".into());
            args.push(index.to_string());
        }
    } else {
        args.push("-map_metadata".into());
        args.push("0".into());
    }

    for (key, value) in &plan.tags {
        if value.trim().is_empty() {
            continue;
        }
        args.push("-metadata".into());
        args.push(format!("{key}={value}"));
    }

    // VP9/AV1 in MP4 is legal but poorly supported; Matroska and WebM are fine.
    if plan.container == "mp4" {
        args.push("-movflags".into());
        args.push("+faststart".into());
    }

    args.extend(crate::services::ytdlp::split_extra_args(
        &settings.advanced.ffmpeg_extra_args,
    ));

    args.push(plan.output.to_string_lossy().to_string());

    let _ = tools;
    args
}

/// Write an `ffmetadata` file describing tags and chapters.
///
/// This is the documented way to carry chapters through a stream copy.
pub fn write_metadata_file(path: &Path, tags: &[(String, String)], chapters: &[ChapterInfo]) -> AppResult<()> {
    let mut body = String::from(";FFMETADATA1\n");

    for (key, value) in tags {
        if value.trim().is_empty() {
            continue;
        }
        body.push_str(&format!("{}={}\n", key, escape_metadata(value)));
    }

    for chapter in chapters {
        let start = (chapter.start_time.max(0.0) * 1000.0).round() as i64;
        let end = chapter
            .end_time
            .unwrap_or(chapter.start_time + 1.0);
        let end = (end.max(chapter.start_time + 0.001) * 1000.0).round() as i64;
        body.push_str("[CHAPTER]\n");
        body.push_str("TIMEBASE=1/1000\n");
        body.push_str(&format!("START={start}\n"));
        body.push_str(&format!("END={end}\n"));
        body.push_str(&format!("title={}\n", escape_metadata(&chapter.title)));
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, body)?;
    Ok(())
}

fn escape_metadata(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('\n', "\\\n")
        .replace('=', "\\=")
        .replace(';', "\\;")
        .replace('#', "\\#")
}

/// Progress reported by `-progress pipe:1`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MergeProgress {
    pub out_time_ms: Option<f64>,
    pub total_size: Option<u64>,
    pub speed: Option<String>,
    pub finished: bool,
}

impl MergeProgress {
    /// Parse one `key=value` line; `None` when the line is not progress.
    pub fn parse(line: &str) -> Option<Self> {
        let (key, value) = line.split_once('=')?;
        let mut progress = Self::default();
        match key.trim() {
            "out_time_ms" | "out_time_us" => {
                progress.out_time_ms = value.trim().parse::<f64>().ok().map(|raw| raw / 1000.0);
            }
            "total_size" => {
                progress.total_size = value.trim().parse::<u64>().ok();
            }
            "speed" => {
                progress.speed = Some(value.trim().to_string());
            }
            "progress" => {
                progress.finished = value.trim() == "end";
            }
            _ => return None,
        }
        Some(progress)
    }

    /// Completion ratio when the media duration is known.
    pub fn ratio(&self, duration_seconds: Option<f64>) -> Option<f64> {
        let total = duration_seconds.filter(|value| *value > 0.0)?;
        let current = self.out_time_ms? / 1000.0;
        Some((current / total).clamp(0.0, 1.0))
    }
}

/// What ffprobe reports about a finished file.
#[derive(Debug, Clone, Default)]
pub struct MediaFacts {
    pub duration: Option<f64>,
    pub size: Option<u64>,
    pub container: Option<String>,
    pub has_video: bool,
    pub has_audio: bool,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
}

pub fn ffprobe_args(path: &Path) -> Vec<String> {
    vec![
        "-hide_banner".into(),
        "-v".into(),
        "error".into(),
        "-show_entries".into(),
        "format=duration,size,format_name:stream=codec_type,codec_name".into(),
        "-of".into(),
        "json".into(),
        path.to_string_lossy().to_string(),
    ]
}

/// Parse the JSON emitted by [`ffprobe_args`].
pub fn parse_ffprobe(payload: &str) -> AppResult<MediaFacts> {
    let value: serde_json::Value = serde_json::from_str(payload)?;
    let mut facts = MediaFacts::default();

    if let Some(format) = value.get("format") {
        facts.duration = format
            .get("duration")
            .and_then(|item| item.as_str())
            .and_then(|text| text.parse::<f64>().ok());
        facts.size = format
            .get("size")
            .and_then(|item| item.as_str())
            .and_then(|text| text.parse::<u64>().ok());
        facts.container = format
            .get("format_name")
            .and_then(|item| item.as_str())
            .map(str::to_string);
    }

    if let Some(streams) = value.get("streams").and_then(|item| item.as_array()) {
        for stream in streams {
            match stream.get("codec_type").and_then(|item| item.as_str()) {
                Some("video") => {
                    facts.has_video = true;
                    facts.video_codec = stream
                        .get("codec_name")
                        .and_then(|item| item.as_str())
                        .map(str::to_string);
                }
                Some("audio") => {
                    facts.has_audio = true;
                    facts.audio_codec = stream
                        .get("codec_name")
                        .and_then(|item| item.as_str())
                        .map(str::to_string);
                }
                _ => {}
            }
        }
    }

    Ok(facts)
}

/// Verify that a merged file really contains both streams.
pub fn verify_facts(facts: &MediaFacts) -> AppResult<()> {
    if !facts.has_video {
        return Err(AppError::Process("合并结果缺少视频流".into()));
    }
    if !facts.has_audio {
        return Err(AppError::Process("合并结果缺少音频流".into()));
    }
    if facts.duration.unwrap_or(0.0) <= 0.0 {
        return Err(AppError::Process("合并结果时长为 0，文件可能已损坏".into()));
    }
    log_debug!(
        "ffmpeg",
        "verified: container={:?} video={:?} audio={:?} duration={:?}",
        facts.container,
        facts.video_codec,
        facts.audio_codec,
        facts.duration
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::settings::AppSettings;

    fn tools() -> ToolSet {
        ToolSet {
            bin_dir: PathBuf::from(r"E:\FFMPEG-9.0\bin"),
            source: crate::runtime::RuntimeSource::Development,
            yt_dlp_exe: None,
            ffmpeg: Some(PathBuf::from(r"E:\FFMPEG-9.0\bin\ffmpeg.exe")),
            ffprobe: Some(PathBuf::from(r"E:\FFMPEG-9.0\bin\ffprobe.exe")),
            launcher: crate::runtime::YtDlpLauncher::Executable(PathBuf::from("yt-dlp.exe")),
        }
    }

    fn plan(container: &str) -> MergePlan {
        MergePlan {
            video: PathBuf::from(r"E:\out\clip.video.webm"),
            audio: PathBuf::from(r"E:\out\clip.audio.webm"),
            output: PathBuf::from(format!(r"E:\out\clip.{container}")),
            container: container.into(),
            thumbnail: None,
            metadata_file: None,
            tags: vec![("title".into(), "Big Buck Bunny".into())],
            chapters: Vec::new(),
            duration: Some(600.0),
        }
    }

    #[test]
    fn merge_is_always_a_stream_copy() {
        let args = merge_args(&AppSettings::default(), &tools(), &plan("mkv"));
        let index = args.iter().position(|item| item == "-c").unwrap();
        assert_eq!(args[index + 1], "copy");
        // No encoder may ever be selected.
        assert!(!args.iter().any(|item| item.starts_with("lib")));
        assert!(!args.contains(&"-filter_complex".to_string()));
    }

    #[test]
    fn both_streams_are_mapped_in_order() {
        let args = merge_args(&AppSettings::default(), &tools(), &plan("mkv"));
        let maps: Vec<&String> = args
            .iter()
            .enumerate()
            .filter(|(_, item)| *item == "-map")
            .map(|(index, _)| &args[index + 1])
            .collect();
        assert_eq!(maps[0], "0:v:0");
        assert_eq!(maps[1], "1:a:0");
    }

    #[test]
    fn thumbnail_and_metadata_indices_follow_the_inputs() {
        let mut with_extras = plan("mkv");
        with_extras.thumbnail = Some(PathBuf::from(r"E:\out\clip.jpg"));
        with_extras.metadata_file = Some(PathBuf::from(r"E:\out\clip.meta"));
        with_extras.chapters = vec![ChapterInfo {
            title: "Intro".into(),
            start_time: 0.0,
            end_time: Some(10.0),
        }];
        let args = merge_args(&AppSettings::default(), &tools(), &with_extras);
        assert!(args.contains(&"2:v:0".to_string()));
        let index = args.iter().position(|item| item == "-map_metadata").unwrap();
        assert_eq!(args[index + 1], "3");
        let index = args.iter().position(|item| item == "-map_chapters").unwrap();
        assert_eq!(args[index + 1], "3");
    }

    #[test]
    fn chapters_are_not_mapped_when_there_are_none() {
        let mut with_metadata = plan("mkv");
        with_metadata.metadata_file = Some(PathBuf::from(r"E:\out\clip.meta"));
        let args = merge_args(&AppSettings::default(), &tools(), &with_metadata);
        assert!(args.contains(&"-map_metadata".to_string()));
        assert!(!args.contains(&"-map_chapters".to_string()));
    }

    #[test]
    fn webm_never_gets_an_attached_cover() {
        let mut with_thumbnail = plan("webm");
        with_thumbnail.thumbnail = Some(PathBuf::from(r"E:\out\clip.jpg"));
        let args = merge_args(&AppSettings::default(), &tools(), &with_thumbnail);
        assert!(!args.contains(&"attached_pic".to_string()));
    }

    #[test]
    fn mp4_output_is_faststart() {
        let args = merge_args(&AppSettings::default(), &tools(), &plan("mp4"));
        assert!(args.contains(&"+faststart".to_string()));
    }

    #[test]
    fn chapter_metadata_is_written_in_ffmetadata_syntax() {
        let dir = std::env::temp_dir().join("ytd-ffmetadata-test");
        let _ = std::fs::remove_dir_all(&dir);
        let file = dir.join("clip.meta");
        write_metadata_file(
            &file,
            &[("title".into(), "A=B; tricky".into())],
            &[
                ChapterInfo {
                    title: "Intro".into(),
                    start_time: 0.0,
                    end_time: Some(30.0),
                },
                ChapterInfo {
                    title: "Main".into(),
                    start_time: 30.0,
                    end_time: Some(90.5),
                },
            ],
        )
        .unwrap();

        let body = std::fs::read_to_string(&file).unwrap();
        assert!(body.starts_with(";FFMETADATA1\n"));
        assert!(body.contains("title=A\\=B\\; tricky"));
        assert_eq!(body.matches("[CHAPTER]").count(), 2);
        assert!(body.contains("START=30000"));
        assert!(body.contains("END=90500"));
        assert!(body.contains("TIMEBASE=1/1000"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn merge_progress_tracks_out_time() {
        let update = MergeProgress::parse("out_time_ms=15000000").unwrap();
        assert_eq!(update.ratio(Some(600.0)), Some(0.025));

        let done = MergeProgress::parse("progress=end").unwrap();
        assert!(done.finished);

        assert!(MergeProgress::parse("frame=12").is_none());
    }

    #[test]
    fn ffprobe_output_is_understood() {
        let payload = r#"{
            "format": { "duration": "635.02", "size": "88000000", "format_name": "matroska,webm" },
            "streams": [
                { "codec_type": "video", "codec_name": "vp9" },
                { "codec_type": "audio", "codec_name": "opus" }
            ]
        }"#;
        let facts = parse_ffprobe(payload).unwrap();
        assert_eq!(facts.duration, Some(635.02));
        assert_eq!(facts.size, Some(88_000_000));
        assert!(facts.has_video && facts.has_audio);
        assert_eq!(facts.video_codec.as_deref(), Some("vp9"));
        assert!(verify_facts(&facts).is_ok());
    }

    #[test]
    fn a_missing_audio_stream_fails_verification() {
        let payload = r#"{
            "format": { "duration": "10", "size": "1", "format_name": "webm" },
            "streams": [ { "codec_type": "video", "codec_name": "vp9" } ]
        }"#;
        let facts = parse_ffprobe(payload).unwrap();
        let error = verify_facts(&facts).unwrap_err();
        assert!(error.to_string().contains("音频流"));
    }

    #[test]
    fn a_zero_length_result_fails_verification() {
        let payload = r#"{
            "format": { "duration": "0", "size": "1", "format_name": "webm" },
            "streams": [
                { "codec_type": "video", "codec_name": "vp9" },
                { "codec_type": "audio", "codec_name": "opus" }
            ]
        }"#;
        let facts = parse_ffprobe(payload).unwrap();
        assert!(verify_facts(&facts).is_err());
    }

    #[test]
    fn user_ffmpeg_arguments_are_appended_before_the_output() {
        let mut settings = AppSettings::default();
        settings.advanced.ffmpeg_extra_args = "-metadata comment=custom".into();
        let args = merge_args(&settings, &tools(), &plan("mkv"));
        let output_index = args.iter().position(|item| item.ends_with("clip.mkv")).unwrap();
        let comment_index = args.iter().position(|item| item == "comment=custom").unwrap();
        assert!(comment_index < output_index);
    }
}
