//! Serializable data models shared with the frontend.

pub mod library;
pub mod media;
pub mod settings;
pub mod task;

pub use library::{FavoriteEntry, HistoryEntry, HistoryStatus};

pub use media::{
    format_duration, short_audio_codec, short_video_codec, ChapterInfo, FormatInfo, FormatOption,
    FormatOptionKind, MediaKind, MediaProbe, PlaylistEntry, SubtitleInfo, ThumbnailInfo,
};
pub use settings::{
    AdvancedSettings, AppSettings, AppearanceSettings, AudioCodecPreference, CodecPreference,
    CookieMode, CookieSettings, DownloadSettings, GeneralSettings, LimitSettings, MergeContainer,
    MotionPreference, NetworkSettings, ProxyMode, ThemeMode, YoutubeSettings, YtDlpRuntimeMode,
};
pub use task::{
    DownloadProgress, DownloadRequest, DownloadResult, DownloadTask, FormatSelection, StreamProgress,
    StreamRole, TaskError, TaskState,
};
