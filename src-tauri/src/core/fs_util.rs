//! Small filesystem helpers shared by the library stores and the shell commands.

use std::path::{Path, PathBuf};

use super::error::{AppError, AppResult};

pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> AppResult<Option<T>> {
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(path)?;
    if text.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_str(&text)?))
}

/// Write JSON atomically: a temporary sibling is written first and then moved over
/// the destination, so a crash mid-write can never leave a truncated library file.
pub fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(value)?;
    std::fs::write(&temporary, body)?;
    std::fs::rename(&temporary, path)?;
    Ok(())
}

pub fn file_size(path: &Path) -> u64 {
    std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
}

/// Total size of a path, following directories one level deep.
pub fn path_size(path: &Path) -> u64 {
    if path.is_file() {
        return file_size(path);
    }
    walkdir::WalkDir::new(path)
        .max_depth(2)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.metadata().map(|meta| meta.len()).unwrap_or(0))
        .sum()
}

pub fn ensure_dir(path: &Path) -> AppResult<()> {
    std::fs::create_dir_all(path)?;
    Ok(())
}

/// Delete a file, ignoring "already gone" and read-only attribute noise.
pub fn remove_file_quietly(path: &Path) {
    if path.exists() {
        if std::fs::remove_file(path).is_err() {
            let mut permissions = match std::fs::metadata(path) {
                Ok(meta) => meta.permissions(),
                Err(_) => return,
            };
            permissions.set_readonly(false);
            let _ = std::fs::set_permissions(path, permissions);
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Delete a directory tree, ignoring failures.
pub fn remove_dir_quietly(path: &Path) {
    if path.exists() {
        let _ = std::fs::remove_dir_all(path);
    }
}

/// List the files in `dir` whose name starts with `prefix`.
pub fn files_with_prefix(dir: &Path, prefix: &str) -> Vec<PathBuf> {
    let mut found = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(prefix) {
                found.push(entry.path());
            }
        }
    }
    found.sort();
    found
}

/// Locate the single file whose name starts with `prefix`, preferring the biggest.
pub fn best_match_for_prefix(dir: &Path, prefix: &str) -> Option<PathBuf> {
    files_with_prefix(dir, prefix)
        .into_iter()
        .filter(|path| path.is_file())
        .max_by_key(|path| file_size(path))
}

/// Open a path with the Windows shell (file → default app, folder → Explorer).
pub fn shell_open(path: &Path) -> AppResult<()> {
    if !path.exists() {
        return Err(AppError::NotFound(format!(
            "路径不存在：{}",
            path.display()
        )));
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path.to_string_lossy()])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|error| AppError::Process(format!("无法打开 {}：{error}", path.display())))?;
        Ok(())
    }

    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|error| AppError::Process(format!("无法打开 {}：{error}", path.display())))?;
        Ok(())
    }
}

/// Open an http(s) URL in the user's default browser.
///
/// Unlike [`shell_open`] this does not require the target to exist on disk, so it is
/// the only honest way to offer "open the original page" for a link.
pub fn shell_open_url(url: &str) -> AppResult<()> {
    let parsed = url::Url::parse(url)
        .map_err(|_| AppError::Message(format!("不是有效的链接：{url}")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AppError::Message("仅支持 http / https 链接".into()));
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", parsed.as_str()])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|error| AppError::Process(format!("无法打开浏览器：{error}")))?;
        Ok(())
    }

    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(parsed.as_str())
            .spawn()
            .map_err(|error| AppError::Process(format!("无法打开浏览器：{error}")))?;
        Ok(())
    }
}

/// Absolute, Explorer-friendly form of a path.
///
/// Explorer resolves a relative path against its *own* working directory, so a relative
/// path would silently open the wrong place; and it does not understand the `\\?\`
/// verbatim prefix that canonicalisation adds. Both are normalised away here.
fn explorer_path(path: &Path) -> PathBuf {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    match absolute.to_string_lossy().strip_prefix(r"\\?\") {
        Some(trimmed) => PathBuf::from(trimmed),
        None => absolute,
    }
}

/// The single command-line token Explorer needs to open a folder with one item selected.
///
/// The switch and the path belong to the *same* token: `/select,"<path>"`. The quotes must
/// reach Explorer inside that token, which is why the caller appends this with `raw_arg`.
/// Going through `Command::arg` instead makes the standard library quote the whole token as
/// soon as the path contains a space — `"/select,D:\My Videos\a.mp4"` — and Explorer then
/// fails to recognise the switch and opens its default folder (Documents) instead of the
/// download. Paths without spaces were passed verbatim, which is why the bug looked random.
fn select_argument(path: &Path) -> String {
    format!("/select,\"{}\"", path.display())
}

/// Reveal a file inside Explorer with the item pre-selected.
pub fn shell_reveal(path: &Path) -> AppResult<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let target = explorer_path(path);

        if target.is_dir() {
            return shell_open(&target);
        }
        if !target.exists() {
            // Fall back to the containing folder when the file itself vanished. An error
            // is always better than opening an unrelated default folder.
            if let Some(parent) = target.parent() {
                if parent.exists() {
                    return shell_open(parent);
                }
            }
            return Err(AppError::NotFound(format!(
                "路径不存在：{}",
                target.display()
            )));
        }

        // `raw_arg` keeps the quoting exactly as Explorer expects it; the standard library
        // would otherwise re-quote the whole `/select,<path>` token.
        let argument = select_argument(&target);
        crate::log_debug!("shell", "explorer.exe {argument}");

        std::process::Command::new("explorer")
            .raw_arg(&argument)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|error| AppError::Process(format!("无法定位 {}：{error}", target.display())))?;
        Ok(())
    }

    #[cfg(not(windows))]
    {
        let parent = path.parent().unwrap_or(path);
        shell_open(parent)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_round_trip_is_atomic() {
        let dir = std::env::temp_dir().join("ytd-fs-util-test");
        let _ = std::fs::remove_dir_all(&dir);
        let file = dir.join("sample.json");
        write_json(&file, &vec!["a", "b"]).unwrap();
        let loaded: Option<Vec<String>> = read_json(&file).unwrap();
        assert_eq!(loaded.unwrap(), vec!["a", "b"]);
        assert!(!file.with_extension("json.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prefix_matching_prefers_the_largest_file() {
        let dir = std::env::temp_dir().join("ytd-prefix-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("clip.video.webm"), vec![0u8; 16]).unwrap();
        std::fs::write(dir.join("clip.video.part"), vec![0u8; 4]).unwrap();
        let best = best_match_for_prefix(&dir, "clip.video").unwrap();
        assert!(best.ends_with("clip.video.webm"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn select_argument_quotes_the_path_but_not_the_switch() {
        // Regression: the whole `/select,<path>` token used to be handed to `Command::arg`,
        // so Rust quoted it as one piece whenever the path contained a space. Explorer then
        // failed to parse the switch and opened Documents.
        assert_eq!(
            select_argument(Path::new(r"D:\Downloads\YouTube\video.mp4")),
            r#"/select,"D:\Downloads\YouTube\video.mp4""#
        );
        assert_eq!(
            select_argument(Path::new(r"D:\视频\YouTube\video.mp4")),
            "/select,\"D:\\视频\\YouTube\\video.mp4\""
        );
        assert_eq!(
            select_argument(Path::new(r"D:\Downloads\鸣潮\寻心.mp4")),
            "/select,\"D:\\Downloads\\鸣潮\\寻心.mp4\""
        );
        assert_eq!(
            select_argument(Path::new(r"D:\Downloads\YouTube Videos\test video.mp4")),
            r#"/select,"D:\Downloads\YouTube Videos\test video.mp4""#
        );
        assert_eq!(
            select_argument(Path::new(r"D:\Downloads\YouTube\test (1080p).mp4")),
            r#"/select,"D:\Downloads\YouTube\test (1080p).mp4""#
        );
        // Shapes this application actually produces: CJK titles, brackets, apostrophes and
        // fullwidth punctuation all survive unchanged.
        assert_eq!(
            select_argument(Path::new(r"E:\下载\【MV】(Live) Don't Stop Me Now！？.mkv")),
            "/select,\"E:\\下载\\【MV】(Live) Don't Stop Me Now！？.mkv\""
        );
    }

    #[test]
    fn explorer_path_is_absolute_and_has_no_verbatim_prefix() {
        let relative = explorer_path(Path::new(r"data\downloads\clip.mkv"));
        assert!(relative.is_absolute());
        assert!(!relative.to_string_lossy().starts_with(r"\\?\"));

        let verbatim = explorer_path(Path::new(r"\\?\E:\下载\clip.mkv"));
        assert_eq!(verbatim, PathBuf::from(r"E:\下载\clip.mkv"));

        let plain = explorer_path(Path::new(r"E:\下载\clip.mkv"));
        assert_eq!(plain, PathBuf::from(r"E:\下载\clip.mkv"));
    }
}
