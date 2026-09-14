//! Filesystem layout.
//!
//! Two hard rules drive this module:
//!
//! 1. Nothing is ever written outside the application directory. There is no
//!    `%LOCALAPPDATA%` fallback, no registry, no hidden cache on the system drive.
//! 2. The media toolchain is looked up only in the two sanctioned locations: the
//!    development runtime (`E:\FFMPEG-9.0`) and the runtime shipped next to the
//!    executable (`<app>\runtime\FFMPEG-9.0`). `PATH` is never consulted.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::error::{AppError, AppResult};

/// The development runtime mandated for this project.
pub const DEV_RUNTIME_BIN: &str = r"E:\FFMPEG-9.0\bin";

/// Directory name of the runtime bundle shipped with a release build.
pub const BUNDLED_RUNTIME_REL: &str = r"runtime\FFMPEG-9.0\bin";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataRoots {
    pub root: PathBuf,
    pub config: PathBuf,
    pub history: PathBuf,
    pub favorites: PathBuf,
    pub logs: PathBuf,
    pub cache: PathBuf,
    pub temp: PathBuf,
    pub downloads: PathBuf,
}

impl DataRoots {
    pub fn ensure(&self) -> AppResult<()> {
        for directory in [
            &self.root,
            &self.config,
            &self.history,
            &self.favorites,
            &self.logs,
            &self.cache,
            &self.temp,
        ] {
            std::fs::create_dir_all(directory)?;
        }
        Ok(())
    }

    pub fn settings_file(&self) -> PathBuf {
        self.config.join("settings.json")
    }

    pub fn history_file(&self) -> PathBuf {
        self.history.join("history.json")
    }

    pub fn favorites_file(&self) -> PathBuf {
        self.favorites.join("favorites.json")
    }

    pub fn log_file(&self) -> PathBuf {
        self.logs.join("yt-downloader.log")
    }
}

/// Resolve the application data root.
///
/// * `YTD_DATA_DIR` wins when set (used by tests and by the verification harness).
/// * Debug builds keep data inside the project so a `tauri dev` session never
///   leaves anything behind in the build output.
/// * Release builds keep data beside the executable, which is what makes the
///   portable distribution genuinely self-contained.
pub fn resolve_data_roots() -> AppResult<DataRoots> {
    let root = if let Some(explicit) = std::env::var_os("YTD_DATA_DIR") {
        PathBuf::from(explicit)
    } else if cfg!(debug_assertions) {
        project_root().join("data")
    } else {
        application_dir()?.join("data")
    };

    Ok(DataRoots {
        config: root.join("config"),
        history: root.join("history"),
        favorites: root.join("favorites"),
        logs: root.join("logs"),
        cache: root.join("cache"),
        temp: root.join("temp"),
        downloads: root.join("downloads"),
        root,
    })
}

/// Repository root of the source tree (only meaningful for debug builds).
pub fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Directory that holds the running executable.
pub fn application_dir() -> AppResult<PathBuf> {
    let exe = std::env::current_exe()?;
    exe.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| AppError::runtime("无法定位应用程序目录"))
}

/// Candidate runtime directories, most specific first.
///
/// `override_dir` comes from user settings and is honoured verbatim when present;
/// auto-discovery then tries the bundled runtime and finally the development one.
pub fn runtime_candidates(override_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(dir) = override_dir {
        if !dir.as_os_str().is_empty() {
            candidates.push(normalise_bin_dir(dir));
        }
    }

    if let Ok(app_dir) = application_dir() {
        candidates.push(app_dir.join(BUNDLED_RUNTIME_REL));
        candidates.push(app_dir.join("runtime").join("FFMPEG-9.0").join("bin"));
    }

    candidates.push(PathBuf::from(DEV_RUNTIME_BIN));

    if cfg!(debug_assertions) {
        let project = project_root();
        candidates.push(project.join(BUNDLED_RUNTIME_REL));
    }

    candidates.dedup();
    candidates
}

/// Accept either a runtime root (`E:\FFMPEG-9.0`), its `bin` folder or a bare
/// directory of executables and normalise it to the folder holding the binaries.
pub fn normalise_bin_dir(dir: &Path) -> PathBuf {
    if dir.join("ffmpeg.exe").is_file() || dir.join("yt-dlp.exe").is_file() {
        return dir.to_path_buf();
    }
    let nested = dir.join("bin");
    if nested.join("ffmpeg.exe").is_file() || nested.join("yt-dlp.exe").is_file() {
        return nested;
    }
    dir.to_path_buf()
}

/// True when a path lives on the system drive.
///
/// Used to warn — never to silently rewrite — when the user points the app at a
/// location that lives on `C:`.
pub fn is_on_c_drive(path: &Path) -> bool {
    match path.components().next() {
        Some(std::path::Component::Prefix(prefix)) => {
            let text = prefix.as_os_str().to_string_lossy().to_ascii_uppercase();
            text.starts_with("C:")
        }
        _ => false,
    }
}

/// Append `-2`, `-3`, … until the path no longer exists.
pub fn unique_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let parent = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let stem = path
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".into());
    let extension = path
        .extension()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();

    for index in 2..1000 {
        let name = if extension.is_empty() {
            format!("{stem} ({index})")
        } else {
            format!("{stem} ({index}).{extension}")
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    path.to_path_buf()
}

/// Strip characters Windows refuses in file names and clamp the length.
pub fn sanitise_file_name(input: &str) -> String {
    const ILLEGAL: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    let mut cleaned: String = input
        .chars()
        .map(|character| {
            if ILLEGAL.contains(&character) || (character as u32) < 0x20 {
                '_'
            } else {
                character
            }
        })
        .collect();

    cleaned = cleaned.trim().trim_end_matches('.').to_string();
    if cleaned.is_empty() {
        cleaned = "download".into();
    }
    // NTFS allows 255; keep headroom for the `.video.webm` / `.audio.webm` suffixes.
    if cleaned.chars().count() > 120 {
        cleaned = cleaned.chars().take(120).collect();
        cleaned = cleaned.trim_end().to_string();
    }
    cleaned
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn c_drive_detection_is_case_insensitive() {
        assert!(is_on_c_drive(Path::new(r"c:\Users\someone\Videos")));
        assert!(is_on_c_drive(Path::new(r"C:\Videos")));
        assert!(!is_on_c_drive(Path::new(r"E:\Videos")));
    }

    #[test]
    fn file_names_are_sanitised() {
        assert_eq!(sanitise_file_name("a/b:c*d?e"), "a_b_c_d_e");
        assert_eq!(sanitise_file_name("   "), "download");
        assert_eq!(sanitise_file_name("trailing."), "trailing");
    }

    #[test]
    fn unique_path_appends_a_counter() {
        let dir = std::env::temp_dir().join("ytd-unique-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let first = dir.join("video.mkv");
        std::fs::write(&first, b"x").unwrap();
        let second = unique_path(&first);
        assert_eq!(second.file_name().unwrap(), "video (2).mkv");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn runtime_candidates_cover_bundled_and_dev_paths() {
        let candidates = runtime_candidates(None);
        assert!(candidates.iter().any(|path| path.ends_with("FFMPEG-9.0\\bin")));
        assert!(candidates
            .iter()
            .any(|path| path.to_string_lossy().eq_ignore_ascii_case(DEV_RUNTIME_BIN)));
    }
}
