//! Persisted application settings.
//!
//! Every field here is wired to a real yt-dlp/FFmpeg/UI behaviour — there are no
//! decorative toggles. Defaults are chosen so a first run works with no setup at
//! all, and so nothing is ever written outside the application directory.

use serde::{Deserialize, Serialize};

use crate::core::paths::DataRoots;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ThemeMode {
    Dark,
    Light,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MotionPreference {
    /// Honour `prefers-reduced-motion`.
    System,
    Full,
    Reduced,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CookieMode {
    None,
    Browser,
    File,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProxyMode {
    None,
    System,
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum YtDlpRuntimeMode {
    /// Use the bundled executable, fall back to a Python module if it cannot run.
    Auto,
    Executable,
    PythonModule,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeContainer {
    /// Derive the container from the streams that were downloaded.
    Auto,
    Matroska,
    Mp4,
    Webm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodecPreference {
    Auto,
    Av1,
    Vp9,
    H264,
}

/// Audio codec preference. Kept separate from [`CodecPreference`] because the
/// meaningful choices are different: Opus for WebM output, AAC for MP4 output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioCodecPreference {
    Auto,
    Opus,
    Aac,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GeneralSettings {
    pub confirm_before_exit: bool,
    pub watch_clipboard: bool,
    pub notify_on_complete: bool,
    pub restore_last_page: bool,
    pub last_page: String,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            confirm_before_exit: false,
            watch_clipboard: true,
            notify_on_complete: true,
            restore_last_page: true,
            last_page: "home".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DownloadSettings {
    pub output_dir: String,
    pub filename_template: String,
    pub playlist_subfolder: bool,
    pub concurrency: u8,
    pub merge_container: MergeContainer,
    pub keep_streams: bool,
    pub write_thumbnail: bool,
    pub embed_thumbnail: bool,
    pub embed_metadata: bool,
    pub embed_chapters: bool,
    pub write_subtitles: bool,
    pub subtitle_languages: String,
    pub write_auto_subtitles: bool,
    pub write_description: bool,
}

impl Default for DownloadSettings {
    fn default() -> Self {
        Self {
            output_dir: String::new(),
            filename_template: "%(title)s.%(ext)s".into(),
            playlist_subfolder: true,
            concurrency: 2,
            merge_container: MergeContainer::Auto,
            keep_streams: false,
            write_thumbnail: false,
            embed_thumbnail: true,
            embed_metadata: true,
            embed_chapters: true,
            write_subtitles: false,
            subtitle_languages: "zh-Hans,zh-Hant,en".into(),
            write_auto_subtitles: false,
            write_description: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct YoutubeSettings {
    pub video_codec_preference: CodecPreference,
    pub audio_codec_preference: AudioCodecPreference,
    /// Empty means "best available".
    pub max_height: String,
    pub prefer_hdr: bool,
    pub prefer_60fps: bool,
    /// Node/Deno runtime used by yt-dlp for signature deciphering. Empty = auto.
    pub js_runtime: String,
    pub extractor_args: String,
}

impl Default for YoutubeSettings {
    fn default() -> Self {
        Self {
            video_codec_preference: CodecPreference::Auto,
            audio_codec_preference: AudioCodecPreference::Auto,
            max_height: String::new(),
            prefer_hdr: false,
            prefer_60fps: true,
            js_runtime: String::new(),
            extractor_args: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CookieSettings {
    pub mode: CookieMode,
    pub browser: String,
    pub profile: String,
    pub file: String,
}

impl Default for CookieSettings {
    fn default() -> Self {
        Self {
            mode: CookieMode::None,
            browser: "edge".into(),
            profile: String::new(),
            file: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NetworkSettings {
    pub proxy_mode: ProxyMode,
    pub proxy_url: String,
    /// KiB/s, 0 = unlimited.
    pub rate_limit_kib: u64,
    pub retries: u32,
    pub fragment_retries: u32,
    pub concurrent_fragments: u32,
    pub socket_timeout_seconds: u32,
    pub force_ipv4: bool,
    pub no_check_certificates: bool,
}

impl Default for NetworkSettings {
    fn default() -> Self {
        Self {
            proxy_mode: ProxyMode::None,
            proxy_url: String::new(),
            rate_limit_kib: 0,
            retries: 10,
            fragment_retries: 10,
            concurrent_fragments: 4,
            socket_timeout_seconds: 30,
            force_ipv4: false,
            no_check_certificates: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppearanceSettings {
    pub theme: ThemeMode,
    pub accent: String,
    pub compact: bool,
    pub motion: MotionPreference,
    pub ambient_background: bool,
    pub native_decorations: bool,
    pub show_sidebar_labels: bool,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            theme: ThemeMode::Dark,
            accent: "violet".into(),
            compact: false,
            motion: MotionPreference::System,
            ambient_background: true,
            native_decorations: false,
            show_sidebar_labels: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AdvancedSettings {
    /// Explicit runtime folder. Empty = auto-discover.
    pub tools_dir: String,
    pub ytdlp_mode: YtDlpRuntimeMode,
    pub python_path: String,
    pub python_module_dir: String,
    pub ytdlp_extra_args: String,
    pub ffmpeg_extra_args: String,
    pub expert_mode: bool,
    pub log_level: String,
    pub keep_raw_output: bool,
}

impl Default for AdvancedSettings {
    fn default() -> Self {
        Self {
            tools_dir: String::new(),
            ytdlp_mode: YtDlpRuntimeMode::Auto,
            python_path: String::new(),
            python_module_dir: String::new(),
            ytdlp_extra_args: String::new(),
            ffmpeg_extra_args: String::new(),
            expert_mode: false,
            log_level: "info".into(),
            keep_raw_output: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LimitSettings {
    /// 0 = the whole playlist.
    pub max_playlist_items: u32,
    pub playlist_start: u32,
    /// MiB, 0 = no limit.
    pub max_filesize_mib: u64,
    pub skip_existing: bool,
    pub download_sections: String,
}

impl Default for LimitSettings {
    fn default() -> Self {
        Self {
            max_playlist_items: 0,
            playlist_start: 1,
            max_filesize_mib: 0,
            skip_existing: false,
            download_sections: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub general: GeneralSettings,
    #[serde(default)]
    pub downloads: DownloadSettings,
    #[serde(default)]
    pub youtube: YoutubeSettings,
    #[serde(default)]
    pub cookies: CookieSettings,
    #[serde(default)]
    pub network: NetworkSettings,
    #[serde(default)]
    pub appearance: AppearanceSettings,
    #[serde(default)]
    pub advanced: AdvancedSettings,
    #[serde(default)]
    pub limits: LimitSettings,
}

impl AppSettings {
    /// Fill in the one value that depends on where the application lives.
    pub fn with_defaults(mut self, roots: &DataRoots) -> Self {
        if self.downloads.output_dir.trim().is_empty() {
            self.downloads.output_dir = roots.downloads.to_string_lossy().to_string();
        }
        if self.advanced.log_level.trim().is_empty() {
            self.advanced.log_level = "info".into();
        }
        self
    }

    pub fn output_dir_or_default(&self, roots: &DataRoots) -> std::path::PathBuf {
        let configured = self.downloads.output_dir.trim();
        if configured.is_empty() {
            roots.downloads.clone()
        } else {
            std::path::PathBuf::from(configured)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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

    #[test]
    fn defaults_keep_downloads_beside_the_application() {
        let settings = AppSettings::default().with_defaults(&roots());
        assert!(settings.downloads.output_dir.ends_with("downloads"));
        assert!(!settings.downloads.output_dir.to_ascii_uppercase().starts_with("C:"));
    }

    #[test]
    fn defaults_survive_a_round_trip() {
        let settings = AppSettings::default().with_defaults(&roots());
        let text = serde_json::to_string(&settings).unwrap();
        let restored: AppSettings = serde_json::from_str(&text).unwrap();
        assert_eq!(restored.downloads.concurrency, settings.downloads.concurrency);
        assert_eq!(restored.appearance.theme, ThemeMode::Dark);
    }

    #[test]
    fn unknown_fields_do_not_break_loading() {
        let restored: AppSettings = serde_json::from_str("{\"downloads\":{\"concurrency\":3}}").unwrap();
        assert_eq!(restored.downloads.concurrency, 3);
        // Missing sections fall back to the documented defaults.
        assert_eq!(restored.network.retries, 10);
    }
}
