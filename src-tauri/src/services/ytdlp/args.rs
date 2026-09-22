//! Building yt-dlp argument vectors.
//!
//! Kept deliberately pure: every function returns a `Vec<String>` from settings and
//! a request, which makes the exact command line unit-testable — including the rules
//! that cookies and credentials never appear in a preview or a log.

use std::path::Path;

use crate::core::paths::DataRoots;
use crate::models::settings::{AppSettings, CookieMode, MergeContainer, ProxyMode};
use crate::models::task::{FormatSelection, StreamRole};
use crate::runtime::ToolSet;

use super::progress::{POSTPROCESS_TEMPLATE, PROGRESS_TEMPLATE};

/// Arguments shared by every yt-dlp invocation: transport, cookies and limits.
fn transport_args(settings: &AppSettings, roots: &DataRoots) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    let network = &settings.network;

    match network.proxy_mode {
        ProxyMode::None => {}
        ProxyMode::System => {
            if let Some(proxy) = system_proxy() {
                args.push("--proxy".into());
                args.push(proxy);
            }
        }
        ProxyMode::Manual => {
            let url = network.proxy_url.trim();
            if !url.is_empty() {
                args.push("--proxy".into());
                args.push(url.to_string());
            }
        }
    }

    if network.force_ipv4 {
        args.push("-4".into());
    }
    if network.no_check_certificates {
        args.push("--no-check-certificates".into());
    }
    if network.retries > 0 {
        args.push("--retries".into());
        args.push(network.retries.to_string());
    }
    if network.fragment_retries > 0 {
        args.push("--fragment-retries".into());
        args.push(network.fragment_retries.to_string());
    }
    if network.concurrent_fragments > 0 {
        args.push("--concurrent-fragments".into());
        args.push(network.concurrent_fragments.to_string());
    }
    if network.socket_timeout_seconds > 0 {
        args.push("--socket-timeout".into());
        args.push(network.socket_timeout_seconds.to_string());
    }
    if network.rate_limit_kib > 0 {
        args.push("--limit-rate".into());
        args.push(format!("{}K", network.rate_limit_kib));
    }

    // Partial files and the resume state live with the application, never in the
    // system temporary folder.
    if let Err(error) = std::fs::create_dir_all(&roots.temp) {
        crate::log_warn!("ytdlp", "cannot create temp dir: {error}");
    }
    args.push("--paths".into());
    args.push(format!("temp:{}", roots.temp.display()));
    args.push("--continue".into());

    if !settings.youtube.extractor_args.trim().is_empty() {
        args.push("--extractor-args".into());
        args.push(settings.youtube.extractor_args.trim().to_string());
    }

    let runtime = settings.youtube.js_runtime.trim();
    let runtime = if runtime.is_empty() {
        // Empty means "auto": use whatever this machine provides, so a fresh install
        // can download YouTube media without any configuration.
        crate::runtime::detect_js_runtime()
    } else {
        Some(runtime.to_string())
    };
    if let Some(runtime) = runtime {
        args.push("--js-runtimes".into());
        args.push(runtime);
    }

    args
}

/// Cookie arguments. Cookie material is never echoed anywhere.
fn cookie_args(settings: &AppSettings) -> Vec<String> {
    match settings.cookies.mode {
        CookieMode::None => Vec::new(),
        CookieMode::Browser => {
            let browser = settings.cookies.browser.trim();
            if browser.is_empty() {
                return Vec::new();
            }
            let profile = settings.cookies.profile.trim();
            let value = if profile.is_empty() {
                browser.to_string()
            } else {
                format!("{browser}:{profile}")
            };
            vec!["--cookies-from-browser".into(), value]
        }
        CookieMode::File => {
            let file = settings.cookies.file.trim();
            if file.is_empty() {
                Vec::new()
            } else {
                vec!["--cookies".into(), file.to_string()]
            }
        }
    }
}

/// Whether the cookie settings actually produce a yt-dlp cookie argument.
///
/// "Cookies are enabled" and "cookies reach yt-dlp" are not the same thing: an empty
/// browser field or an empty cookies.txt path yields no argument at all. Diagnostics and
/// logs go through this so they never claim cookies were used when nothing was passed.
pub fn cookies_are_effective(settings: &AppSettings) -> bool {
    !cookie_args(settings).is_empty()
}

/// Tell yt-dlp exactly which FFmpeg to use.
fn ffmpeg_location(tools: &ToolSet) -> Option<String> {
    tools
        .ffmpeg
        .as_ref()
        .and_then(|path| path.parent())
        .map(|parent| parent.to_string_lossy().to_string())
}

/// Split a user-supplied argument string, honouring simple quoting.
pub fn split_extra_args(raw: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;

    for character in raw.chars() {
        match (quote, character) {
            (Some(active), value) if value == active => quote = None,
            (Some(_), value) => current.push(value),
            (None, '"') | (None, '\'') => quote = Some(character),
            (None, value) if value.is_whitespace() => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            (None, value) => current.push(value),
        }
    }
    if !current.is_empty() {
        args.push(current);
    }
    args
}

/// Read the WinINET proxy for the current user out of the registry.
///
/// Implemented with `reg query` so the backend needs no extra dependency, and a
/// missing key simply means "no system proxy".
pub fn system_proxy() -> Option<String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let output = std::process::Command::new("reg")
            .args([
                "query",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout);

        let enabled = text
            .lines()
            .find(|line| line.contains("ProxyEnable"))
            .map(|line| line.contains("0x1"))
            .unwrap_or(false);
        if !enabled {
            return None;
        }

        let server = text
            .lines()
            .find(|line| line.contains("ProxyServer"))
            .and_then(|line| line.split("REG_SZ").nth(1))
            .map(str::trim)
            .filter(|value| !value.is_empty())?;

        // `ProxyServer` may be "host:port" or a per-scheme list.
        let candidate = if server.contains('=') {
            server
                .split(';')
                .find_map(|entry| entry.strip_prefix("https="))
                .or_else(|| server.split(';').find_map(|entry| entry.strip_prefix("http=")))
                .unwrap_or(server)
        } else {
            server
        };

        Some(if candidate.contains("://") {
            candidate.to_string()
        } else {
            format!("http://{candidate}")
        })
    }

    #[cfg(not(windows))]
    {
        None
    }
}

/// A selector that still resolves when the exact format id has disappeared.
///
/// YouTube answers two extractions of the same video with slightly different format
/// sets — a probe can legitimately offer an id that the download request no longer
/// has. Rather than failing the task, one retry is made with an equivalent selector:
/// the same quality when the height is known, and always with a last-resort clause so
/// a download cannot fail twice for the same reason.
pub fn fallback_format_expression(role: StreamRole, height: Option<u32>) -> String {
    match (role, height) {
        // One file: the video and its audio are muxed by yt-dlp.
        (StreamRole::Single, Some(height)) => format!(
            "bv*[height<={height}]+ba/b[height<={height}]/bv*+ba/b"
        ),
        (StreamRole::Single, None) => "bv*+ba/b".into(),
        // Two files: the audio is fetched by its own task, so the video selector must
        // stay video-only whenever a video-only candidate exists.
        (StreamRole::Video, Some(height)) => format!("bv*[height<={height}]/bv*"),
        (StreamRole::Video, None) => "bv*".into(),
        (StreamRole::Audio, _) => "ba/b".into(),
    }
}

/// Force yt-dlp's *output* encoding.
///
/// Without this the tool encodes its messages with the console code page — GBK on a
/// Chinese Windows — so a line containing a CJK title or file name arrives as bytes
/// that are not valid UTF-8. The backend reads those lines as UTF-8 and must never
/// be asked to guess the locale, so the encoding is pinned at the source.
fn output_encoding_args() -> Vec<String> {
    vec!["--encoding".into(), "utf-8".into()]
}

/// Arguments for the metadata probe.
pub fn probe_args(
    settings: &AppSettings,
    roots: &DataRoots,
    tools: &ToolSet,
    url: &str,
    playlist: bool,
) -> Vec<String> {
    let mut args = vec![
        "--dump-single-json".to_string(),
        "--no-warnings".to_string(),
        "--ignore-config".to_string(),
        "--skip-download".to_string(),
    ];
    args.extend(output_encoding_args());

    // A flat playlist keeps a channel probe fast: yt-dlp reports the entries without
    // resolving every video's formats.
    if playlist {
        args.push("--flat-playlist".to_string());
        let limit = if settings.limits.max_playlist_items > 0 {
            settings.limits.max_playlist_items
        } else {
            200
        };
        args.push("--playlist-end".to_string());
        args.push(limit.to_string());
    }

    if let Some(location) = ffmpeg_location(tools) {
        args.push("--ffmpeg-location".into());
        args.push(location);
    }

    args.extend(transport_args(settings, roots));
    args.extend(cookie_args(settings));
    args.extend(split_extra_args(&settings.advanced.ytdlp_extra_args));
    args.push(url.to_string());
    args
}

/// One downloadable stream of a task.
#[derive(Debug, Clone, PartialEq)]
pub struct StreamSpec {
    pub role: StreamRole,
    pub format_id: String,
    /// Output template without extension, e.g. `E:\out\Title.video`.
    pub output_prefix: String,
}

/// Arguments for downloading a single stream into `prefix.%(ext)s`.
pub fn stream_args(
    settings: &AppSettings,
    roots: &DataRoots,
    tools: &ToolSet,
    stream: &StreamSpec,
    url: &str,
    embed_here: bool,
) -> Vec<String> {
    let mut args = vec![
        "--newline".to_string(),
        "--ignore-config".to_string(),
        "--progress".to_string(),
        "--progress-template".to_string(),
        PROGRESS_TEMPLATE.to_string(),
        "--progress-template".to_string(),
        POSTPROCESS_TEMPLATE.to_string(),
        "--no-mtime".to_string(),
        "--trim-filenames".to_string(),
        "150".to_string(),
    ];
    args.extend(output_encoding_args());

    args.push("--format".into());
    args.push(stream.format_id.clone());

    args.push("--output".into());
    args.push(format!("{}.%(ext)s", stream.output_prefix));

    if let Some(location) = ffmpeg_location(tools) {
        args.push("--ffmpeg-location".into());
        args.push(location);
    }

    // Playlist handling: a task addresses either one video or a whole playlist.
    if is_playlist_url(url) {
        args.push("--yes-playlist".into());
        if settings.limits.max_playlist_items > 0 {
            args.push("--playlist-end".into());
            args.push(settings.limits.max_playlist_items.to_string());
        }
        if settings.limits.playlist_start > 1 {
            args.push("--playlist-start".into());
            args.push(settings.limits.playlist_start.to_string());
        }
    } else {
        args.push("--no-playlist".into());
    }

    if settings.limits.max_filesize_mib > 0 {
        args.push("--max-filesize".into());
        args.push(format!("{}M", settings.limits.max_filesize_mib));
    }
    if !settings.limits.download_sections.trim().is_empty() {
        args.push("--download-sections".into());
        args.push(settings.limits.download_sections.trim().to_string());
    }
    if settings.limits.skip_existing {
        args.push("--download-archive".into());
        args.push(
            roots
                .history
                .join("download-archive.txt")
                .to_string_lossy()
                .to_string(),
        );
    }

    args.extend(transport_args(settings, roots));
    args.extend(cookie_args(settings));
    args.extend(sidecar_args(settings, embed_here));
    args.extend(split_extra_args(&settings.advanced.ytdlp_extra_args));
    args.push(url.to_string());
    args
}

/// Subtitle and thumbnail sidecars.
///
/// `embed_here` is true for muxed formats, where yt-dlp performs the FFmpeg
/// post-processing itself; for split streams the merge step embeds them instead, so
/// only the sidecar files are requested here.
fn sidecar_args(settings: &AppSettings, embed_here: bool) -> Vec<String> {
    let downloads = &settings.downloads;
    let mut args: Vec<String> = Vec::new();

    if downloads.write_thumbnail || (embed_here && downloads.embed_thumbnail) {
        args.push("--write-thumbnail".into());
        args.push("--convert-thumbnails".into());
        args.push("jpg".into());
    }

    if downloads.write_subtitles {
        args.push("--write-subs".into());
        let languages = downloads.subtitle_languages.trim();
        if !languages.is_empty() {
            args.push("--sub-langs".into());
            args.push(languages.to_string());
        }
        args.push("--convert-subs".into());
        args.push("srt".into());
    }

    if downloads.write_auto_subtitles {
        args.push("--write-auto-subs".into());
        let languages = downloads.subtitle_languages.trim();
        if !languages.is_empty() && !downloads.write_subtitles {
            args.push("--sub-langs".into());
            args.push(languages.to_string());
        }
    }

    if downloads.write_description {
        args.push("--write-description".into());
    }

    if embed_here {
        if downloads.embed_metadata {
            args.push("--embed-metadata".into());
        }
        if downloads.embed_chapters {
            args.push("--embed-chapters".into());
        }
        if downloads.embed_thumbnail {
            args.push("--embed-thumbnail".into());
        }
        if downloads.write_subtitles {
            args.push("--embed-subs".into());
        }
    }

    args
}

/// A yt-dlp call that only fetches the thumbnail for a video.
pub fn thumbnail_args(
    settings: &AppSettings,
    roots: &DataRoots,
    tools: &ToolSet,
    url: &str,
    output_prefix: &str,
) -> Vec<String> {
    let mut args = vec![
        "--skip-download".to_string(),
        "--no-warnings".to_string(),
        "--write-thumbnail".to_string(),
        "--convert-thumbnails".to_string(),
        "jpg".to_string(),
        "--output".to_string(),
        format!("{output_prefix}.%(ext)s"),
        "--no-playlist".to_string(),
    ];
    if let Some(location) = ffmpeg_location(tools) {
        args.push("--ffmpeg-location".into());
        args.push(location);
    }
    args.extend(transport_args(settings, roots));
    args.extend(cookie_args(settings));
    args.push(url.to_string());
    args
}

/// True for URLs that address a playlist, channel or a video inside a list.
pub fn is_playlist_url(url: &str) -> bool {
    let lowered = url.to_ascii_lowercase();
    lowered.contains("list=")
        || lowered.contains("/playlist")
        || lowered.contains("/channel/")
        || lowered.contains("/videos")
        || lowered.contains("/streams")
        || lowered.contains("/@")
        || lowered.contains("/c/")
        || lowered.contains("/user/")
}

/// Container chosen for the merged output.
pub fn resolve_container(preference: MergeContainer, video_ext: &str, audio_ext: &str) -> String {
    match preference {
        MergeContainer::Matroska => "mkv".into(),
        MergeContainer::Mp4 => "mp4".into(),
        MergeContainer::Webm => "webm".into(),
        MergeContainer::Auto => {
            let video = video_ext.to_ascii_lowercase();
            let audio = audio_ext.to_ascii_lowercase();
            if video.starts_with("webm") && (audio.starts_with("webm") || audio.starts_with("opus")) {
                // VP9/AV1 + Opus is native in WebM and stays playable everywhere
                // Matroska is understood.
                "webm".into()
            } else if (video.starts_with("mp4") || video.starts_with("m4v"))
                && (audio.starts_with("m4a") || audio.starts_with("mp4"))
            {
                "mp4".into()
            } else {
                "mkv".into()
            }
        }
    }
}

/// Best-effort extension list used when locating downloaded stream files.
pub fn candidate_extensions(video_ext: &str, audio_ext: &str) -> Vec<String> {
    let mut extensions: Vec<String> = Vec::new();
    for candidate in [video_ext, audio_ext, "webm", "mp4", "m4a", "mkv", "opus", "aac", "mp3"] {
        let value = candidate.trim().trim_start_matches('.').to_ascii_lowercase();
        if !value.is_empty() && value != "bin" && !extensions.contains(&value) {
            extensions.push(value);
        }
    }
    extensions
}

/// Human readable description of the plan for the task card.
pub fn selection_summary(selection: &FormatSelection) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !selection.label.is_empty() {
        parts.push(selection.label.clone());
    }
    if let Some(codec) = &selection.video_codec {
        parts.push(codec.clone());
    }
    if let Some(codec) = &selection.audio_codec {
        parts.push(codec.clone());
    }
    if selection.hdr {
        parts.push("HDR".into());
    }
    if !selection.container.is_empty() {
        parts.push(selection.container.to_ascii_uppercase());
    }
    parts.join(" · ")
}

/// True when the path is a readable cookie file (used by settings validation).
pub fn cookie_file_is_readable(path: &str) -> bool {
    Path::new(path).is_file()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::paths::DataRoots;
    use crate::models::settings::{CookieMode, ThemeMode};
    use std::path::PathBuf;

    fn roots() -> DataRoots {
        let root = PathBuf::from(r"E:\app\data");
        DataRoots {
            config: root.join("config"),
            history: root.join("history"),
            favorites: root.join("favorites"),
            logs: root.join("logs"),
            cache: root.join("cache"),
            temp: root.join("temp"),
            downloads: root.join("downloads"),
            root,
        }
    }

    fn tools() -> ToolSet {
        ToolSet {
            bin_dir: PathBuf::from(r"E:\FFMPEG-9.0\bin"),
            source: crate::runtime::RuntimeSource::Development,
            yt_dlp_exe: Some(PathBuf::from(r"E:\FFMPEG-9.0\bin\yt-dlp.exe")),
            ffmpeg: Some(PathBuf::from(r"E:\FFMPEG-9.0\bin\ffmpeg.exe")),
            ffprobe: Some(PathBuf::from(r"E:\FFMPEG-9.0\bin\ffprobe.exe")),
            launcher: crate::runtime::YtDlpLauncher::Executable(PathBuf::from(
                r"E:\FFMPEG-9.0\bin\yt-dlp.exe",
            )),
        }
    }

    fn settings() -> AppSettings {
        AppSettings {
            appearance: crate::models::settings::AppearanceSettings {
                theme: ThemeMode::Dark,
                ..Default::default()
            },
            ..Default::default()
        }
    }

    #[test]
    fn probe_uses_json_and_never_a_simulated_download() {
        let args = probe_args(
            &settings(),
            &roots(),
            &tools(),
            "https://www.youtube.com/watch?v=abc",
            false,
        );
        assert!(args.contains(&"--dump-single-json".to_string()));
        assert!(args.contains(&"--skip-download".to_string()));
        assert!(args.contains(&"--no-playlist".to_string()) || !args.contains(&"--yes-playlist".to_string()));
        assert_eq!(args.last().unwrap(), "https://www.youtube.com/watch?v=abc");
    }

    #[test]
    fn playlist_probes_are_capped_and_flat() {
        let mut settings = settings();
        settings.limits.max_playlist_items = 25;
        let args = probe_args(&settings, &roots(), &tools(), "https://www.youtube.com/@chan", true);
        assert!(args.contains(&"--flat-playlist".to_string()));
        let index = args.iter().position(|item| item == "--playlist-end").unwrap();
        assert_eq!(args[index + 1], "25");
    }

    #[test]
    fn a_missing_format_id_falls_back_to_an_equivalent_selector() {
        // The retry must stay close to what the user chose, and must always resolve.
        assert_eq!(
            fallback_format_expression(StreamRole::Single, Some(360)),
            "bv*[height<=360]+ba/b[height<=360]/bv*+ba/b"
        );
        assert_eq!(
            fallback_format_expression(StreamRole::Single, None),
            "bv*+ba/b"
        );
        assert_eq!(
            fallback_format_expression(StreamRole::Video, Some(1080)),
            "bv*[height<=1080]/bv*"
        );
        assert_eq!(fallback_format_expression(StreamRole::Video, None), "bv*");
        assert_eq!(fallback_format_expression(StreamRole::Audio, Some(360)), "ba/b");
    }

    #[test]
    fn yt_dlp_output_is_pinned_to_utf8() {
        // Regression: without this the child encodes its messages with the console
        // code page, and a CJK title arrives as bytes that are not valid UTF-8.
        let probe = probe_args(&settings(), &roots(), &tools(), "u", false);
        let index = probe.iter().position(|item| item == "--encoding").unwrap();
        assert_eq!(probe[index + 1], "utf-8");

        let stream = stream_args(
            &settings(),
            &roots(),
            &tools(),
            &StreamSpec {
                role: StreamRole::Single,
                format_id: "18".into(),
                output_prefix: r"E:\out\clip".into(),
            },
            "u",
            true,
        );
        let index = stream.iter().position(|item| item == "--encoding").unwrap();
        assert_eq!(stream[index + 1], "utf-8");
        assert!(!stream.contains(&"--no-call-home".to_string()));
    }

    #[test]
    fn embedded_ffmpeg_location_points_at_the_runtime() {
        let args = probe_args(&settings(), &roots(), &tools(), "u", false);
        let index = args.iter().position(|item| item == "--ffmpeg-location").unwrap();
        assert_eq!(args[index + 1], r"E:\FFMPEG-9.0\bin");
    }

    #[test]
    fn cookies_are_passed_but_never_repeated_in_the_preview() {
        let mut settings = settings();
        settings.cookies.mode = CookieMode::File;
        settings.cookies.file = r"E:\secrets\cookies.txt".into();
        let args = stream_args(
            &settings,
            &roots(),
            &tools(),
            &StreamSpec {
                role: StreamRole::Video,
                format_id: "137".into(),
                output_prefix: r"E:\out\clip.video".into(),
            },
            "https://youtu.be/x",
            false,
        );
        assert!(args.contains(&r"E:\secrets\cookies.txt".to_string()));

        let preview = crate::process::render_preview(&PathBuf::from("yt-dlp.exe"), &args);
        assert!(!preview.contains("cookies.txt"));
    }

    #[test]
    fn browser_cookies_include_an_optional_profile() {
        let mut settings = settings();
        settings.cookies.mode = CookieMode::Browser;
        settings.cookies.browser = "edge".into();
        settings.cookies.profile = "Default".into();
        let args = stream_args(
            &settings,
            &roots(),
            &tools(),
            &StreamSpec {
                role: StreamRole::Single,
                format_id: "18".into(),
                output_prefix: r"E:\out\clip".into(),
            },
            "u",
            true,
        );
        let index = args
            .iter()
            .position(|item| item == "--cookies-from-browser")
            .unwrap();
        assert_eq!(args[index + 1], "edge:Default");
    }

    #[test]
    fn split_streams_do_not_ask_yt_dlp_to_embed() {
        let mut settings = settings();
        settings.downloads.embed_metadata = true;
        settings.downloads.embed_thumbnail = true;
        settings.downloads.embed_chapters = true;
        let args = stream_args(
            &settings,
            &roots(),
            &tools(),
            &StreamSpec {
                role: StreamRole::Video,
                format_id: "137".into(),
                output_prefix: r"E:\out\clip.video".into(),
            },
            "u",
            false,
        );
        assert!(!args.contains(&"--embed-metadata".to_string()));
        assert!(!args.contains(&"--embed-thumbnail".to_string()));
        assert!(!args.contains(&"--embed-chapters".to_string()));
    }

    #[test]
    fn muxed_downloads_embed_inside_yt_dlp() {
        let mut settings = settings();
        settings.downloads.embed_metadata = true;
        settings.downloads.embed_thumbnail = true;
        let args = stream_args(
            &settings,
            &roots(),
            &tools(),
            &StreamSpec {
                role: StreamRole::Single,
                format_id: "18".into(),
                output_prefix: r"E:\out\clip".into(),
            },
            "u",
            true,
        );
        assert!(args.contains(&"--embed-metadata".to_string()));
        assert!(args.contains(&"--embed-thumbnail".to_string()));
    }

    #[test]
    fn progress_template_and_resume_flags_are_always_present() {
        let args = stream_args(
            &settings(),
            &roots(),
            &tools(),
            &StreamSpec {
                role: StreamRole::Audio,
                format_id: "251".into(),
                output_prefix: r"E:\out\clip.audio".into(),
            },
            "u",
            false,
        );
        assert!(args.contains(&"--progress-template".to_string()));
        assert!(args.contains(&"--continue".to_string()));
        assert!(args.contains(&"--newline".to_string()));
        let paths = args.iter().position(|item| item == "--paths").unwrap();
        assert!(args[paths + 1].starts_with("temp:"));
    }

    #[test]
    fn output_templates_keep_the_stream_suffix() {
        let args = stream_args(
            &settings(),
            &roots(),
            &tools(),
            &StreamSpec {
                role: StreamRole::Video,
                format_id: "137".into(),
                output_prefix: r"E:\out\My Clip.video".into(),
            },
            "u",
            false,
        );
        let index = args.iter().position(|item| item == "--output").unwrap();
        assert_eq!(args[index + 1], r"E:\out\My Clip.video.%(ext)s");
    }

    #[test]
    fn extra_arguments_respect_quotes() {
        assert_eq!(
            split_extra_args(r#"--foo --bar "a b" 'c d'"#),
            vec!["--foo", "--bar", "a b", "c d"]
        );
        assert!(split_extra_args("   ").is_empty());
    }

    #[test]
    fn an_explicit_js_runtime_is_passed_through() {
        let mut settings = settings();
        settings.youtube.js_runtime = "deno".into();
        let args = probe_args(&settings, &roots(), &tools(), "u", false);
        let index = args
            .iter()
            .position(|item| item == "--js-runtimes")
            .expect("explicit runtime must be forwarded");
        assert_eq!(args[index + 1], "deno");
    }

    #[test]
    fn an_unset_js_runtime_falls_back_to_detection() {
        // With no explicit choice the flag carries whatever this machine provides.
        // When nothing is installed the flag is simply absent, which is also correct.
        let args = probe_args(&settings(), &roots(), &tools(), "u", false);
        if let Some(index) = args.iter().position(|item| item == "--js-runtimes") {
            assert!(
                !args[index + 1].is_empty(),
                "a detected runtime name must never be empty"
            );
        }
    }

    #[test]
    fn playlist_urls_are_recognised() {
        assert!(is_playlist_url("https://www.youtube.com/playlist?list=PL1"));
        assert!(is_playlist_url("https://www.youtube.com/@SomeChannel/videos"));
        assert!(is_playlist_url("https://www.youtube.com/watch?v=a&list=PL1"));
        assert!(!is_playlist_url("https://www.youtube.com/watch?v=aqz-KE-bpKQ"));
        assert!(!is_playlist_url("https://youtu.be/aqz-KE-bpKQ"));
    }

    #[test]
    fn container_choice_follows_the_codecs() {
        assert_eq!(
            resolve_container(MergeContainer::Auto, "webm", "webm"),
            "webm"
        );
        assert_eq!(
            resolve_container(MergeContainer::Auto, "mp4", "m4a"),
            "mp4"
        );
        assert_eq!(
            resolve_container(MergeContainer::Auto, "webm", "m4a"),
            "mkv"
        );
        assert_eq!(
            resolve_container(MergeContainer::Matroska, "mp4", "m4a"),
            "mkv"
        );
    }

    #[test]
    fn candidate_extensions_are_deduplicated() {
        let extensions = candidate_extensions("webm", "webm");
        assert_eq!(extensions[0], "webm");
        assert_eq!(extensions.iter().filter(|item| *item == "webm").count(), 1);
        assert!(extensions.contains(&"mp4".to_string()));
    }

    #[test]
    fn selection_summaries_read_naturally() {
        let selection = FormatSelection {
            label: "1080p60".into(),
            video_codec: Some("AV1".into()),
            audio_codec: Some("Opus".into()),
            container: "webm".into(),
            hdr: true,
            ..Default::default()
        };
        assert_eq!(selection_summary(&selection), "1080p60 · AV1 · Opus · HDR · WEBM");
    }
}
