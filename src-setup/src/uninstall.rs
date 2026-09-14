//! Uninstallation.
//!
//! Product rule: removing the application must never remove the user's videos. Only
//! the program's own files are deleted by default; application data (settings,
//! history, favourites, logs, caches) and downloaded media are removed **only** when
//! the user explicitly asks for each of them, and downloaded media is refused
//! outright when it lives outside the installation directory.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::platform;
use crate::progress::{ProgressReporter, SetupFinished};
use crate::{SetupError, SetupState};

const STEPS: &[(&str, &str)] = &[
    ("prepare", "读取安装信息"),
    ("files", "删除程序文件"),
    ("shortcuts", "移除快捷方式"),
    ("register", "清除卸载信息"),
    ("finalize", "完成卸载"),
];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallOptions {
    /// Remove settings, history, favourites, logs and caches.
    pub remove_app_data: bool,
    /// Remove downloaded media. Off by default and never assumed.
    pub remove_downloads: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallOutcome {
    pub install_dir: PathBuf,
    pub removed_entries: Vec<String>,
    pub app_data_kept: bool,
    pub downloads_kept: bool,
    pub kept_data_path: Option<PathBuf>,
    pub warnings: Vec<String>,
}

/// Directories inside `data\` that belong to the application rather than to the user's
/// library of downloaded files.
const APP_DATA_FOLDERS: [&str; 6] = ["config", "history", "favorites", "logs", "cache", "temp"];

pub fn run_uninstall(
    app: AppHandle,
    state: Arc<SetupState>,
    options: UninstallOptions,
) -> Result<UninstallOutcome, SetupError> {
    let mut reporter = ProgressReporter::new(app, "uninstall", STEPS);
    let mut warnings: Vec<String> = Vec::new();
    let mut removed: Vec<String> = Vec::new();

    // ---- 1. locate the installation ---------------------------------------
    reporter.begin(0, "正在读取安装位置…");
    let install_dir = resolve_install_dir()?;
    if !install_dir.exists() {
        return Err(SetupError::Message(format!(
            "找不到安装目录：{}",
            install_dir.display()
        )));
    }

    // Resolve the *effective* download folder before anything is deleted, so a
    // user-chosen location outside the installation is honoured and never touched.
    let effective_downloads = effective_download_dir(&install_dir);
    let app_exe = install_dir.join(platform::APP_EXE_NAME);
    if !app_exe.exists() {
        warnings.push(format!(
            "{} 中找不到 {}，将仍然清理其余程序文件。",
            install_dir.display(),
            platform::APP_EXE_NAME
        ));
    }
    reporter.complete(0);

    // ---- 2. program files --------------------------------------------------
    reporter.begin(1, "正在删除程序文件…");
    let self_path = std::env::current_exe().ok();
    let entries: Vec<PathBuf> = std::fs::read_dir(&install_dir)
        .map_err(SetupError::Io)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .collect();

    for entry in entries {
        if state.cancel.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(SetupError::Cancelled);
        }
        let name = entry
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default();

        // The data directory is handled below and the running uninstaller is removed
        // by the detached cleanup step.
        if name.eq_ignore_ascii_case("data") {
            continue;
        }
        if let Some(current) = &self_path {
            if entry == *current {
                continue;
            }
        }

        platform::remove_path(&entry);
        removed.push(name);
    }
    reporter.set(0.45, "程序文件已删除");
    reporter.complete(1);

    // ---- 3. user data ------------------------------------------------------
    reporter.begin(2, "正在处理用户数据…");
    let data_root = install_dir.join("data");

    let mut app_data_kept = true;
    if options.remove_app_data {
        for folder in APP_DATA_FOLDERS {
            let path = data_root.join(folder);
            if path.exists() {
                platform::remove_path(&path);
                removed.push(format!("data\\{folder}"));
            }
        }
        // The webview profile is application data too.
        let webview = data_root.join("webview");
        if webview.exists() {
            platform::remove_path(&webview);
            removed.push("data\\webview".into());
        }
        app_data_kept = false;
    } else if data_root.exists() {
        app_data_kept = true;
    }

    let mut downloads_kept = true;
    if options.remove_downloads {
        let inside_install = effective_downloads
            .canonicalize()
            .map(|path| path.starts_with(&install_dir))
            .unwrap_or(false)
            || effective_downloads.starts_with(&install_dir);

        if !inside_install {
            // The user pointed the download folder somewhere else: it is their data,
            // not ours, and an uninstaller must not reach outside its own directory.
            warnings.push(format!(
                "下载目录位于安装目录之外，已保留：{}",
                effective_downloads.display()
            ));
        } else if effective_downloads.exists() {
            platform::remove_path(&effective_downloads);
            removed.push("data\\downloads".into());
            downloads_kept = false;
        } else {
            downloads_kept = false;
        }
    }
    reporter.set(0.6, "用户数据已按选择处理");
    reporter.complete(2);

    // When nothing was kept, the data directory itself must go too — otherwise the
    // installation folder can never become empty and would be left behind. `remove_dir`
    // is deliberately non-recursive: it only succeeds on an empty directory, so any
    // file the user still has there keeps the folder alive.
    if data_root.exists() {
        let _ = std::fs::remove_dir(&data_root);
    }

    // ---- 4. shortcuts ------------------------------------------------------
    reporter.begin(3, "正在移除快捷方式…");
    if let Some(programs) = platform::start_menu_programs() {
        let folder = programs.join(platform::APP_DIR_NAME);
        if folder.exists() {
            platform::remove_path(&folder);
            removed.push(folder.to_string_lossy().to_string());
        }
    }
    if let Some(desktop) = platform::desktop() {
        let lnk = desktop.join("YT Downloader.lnk");
        if lnk.exists() {
            platform::remove_path(&lnk);
            removed.push(lnk.to_string_lossy().to_string());
        }
    }

    // ---- 5. Add/Remove Programs -------------------------------------------
    if let Err(error) = platform::remove_uninstall_entry() {
        warnings.push(format!("清除注册表卸载信息失败：{error}"));
    }
    reporter.complete(3);

    reporter.begin(4, "正在完成卸载…");
    reporter.set(0.97, "卸载完成");
    reporter.complete(4);

    let kept_data_path = if app_data_kept || downloads_kept {
        data_root.exists().then(|| data_root.clone())
    } else {
        None
    };

    // The running executable cannot delete itself; hand that to a detached process.
    // Recursion is enabled only when nothing of the user's was kept, so the removal can
    // never reach a file that belongs to them.
    //
    // Self-deletion happens only when this program actually lives inside the
    // installation directory. A copy started from somewhere else — the distributed
    // setup file used as an uninstaller, for instance — must never delete itself: that
    // file belongs to the user, not to the installation.
    let self_inside_install = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|dir| dir.to_path_buf()))
        .map(|dir| dir.to_string_lossy().eq_ignore_ascii_case(&install_dir.to_string_lossy()))
        .unwrap_or(false);

    let remove_tree = !app_data_kept && !downloads_kept;
    platform::schedule_self_cleanup(&install_dir, remove_tree, self_inside_install);

    reporter.set(1.0, "卸载完成");
    reporter.finish(SetupFinished {
        ok: true,
        mode: "uninstall".into(),
        install_dir: Some(install_dir.to_string_lossy().to_string()),
        error: None,
        detail: if warnings.is_empty() {
            None
        } else {
            Some(warnings.join("\n"))
        },
        app_data_kept,
        downloads_kept,
        kept_data_path: kept_data_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
    });

    Ok(UninstallOutcome {
        install_dir,
        removed_entries: removed,
        app_data_kept,
        downloads_kept,
        kept_data_path,
        warnings,
    })
}

/// Where is the application installed?
///
/// The uninstaller normally runs from the installation directory itself. When it was
/// copied elsewhere (a shortcut was edited, or the user moved it), the registry is
/// authoritative.
pub fn resolve_install_dir() -> Result<PathBuf, SetupError> {
    let own_dir = std::env::current_exe()?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| SetupError::Message("无法确定卸载程序所在目录。".into()))?;

    if own_dir.join(platform::APP_EXE_NAME).exists() {
        return Ok(own_dir);
    }

    if let Some(registered) = platform::read_install_location() {
        return Ok(registered);
    }

    Ok(own_dir)
}

/// The download folder the application is actually configured to use.
///
/// `settings.json` is read before anything is deleted so a folder the user chose in
/// the app — anywhere on disk — is respected rather than guessed.
pub fn effective_download_dir(install_dir: &Path) -> PathBuf {
    let default = install_dir.join("data").join("downloads");
    let settings = install_dir.join("data").join("config").join("settings.json");

    let Ok(text) = std::fs::read_to_string(&settings) else {
        return default;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return default;
    };

    value
        .get("downloads")
        .and_then(|downloads| downloads.get("outputDir"))
        .and_then(|dir| dir.as_str())
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_download_folder_follows_the_saved_settings() {
        let dir = std::env::temp_dir().join("ytd-setup-uninstall-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("data/config")).unwrap();

        // Without settings the default location is used.
        assert_eq!(
            effective_download_dir(&dir),
            dir.join("data").join("downloads")
        );

        std::fs::write(
            dir.join("data/config/settings.json"),
            r#"{"downloads":{"outputDir":"D:\\Videos"}}"#,
        )
        .unwrap();
        assert_eq!(
            effective_download_dir(&dir),
            PathBuf::from(r"D:\Videos")
        );

        // An empty value falls back to the default rather than to the drive root.
        std::fs::write(
            dir.join("data/config/settings.json"),
            r#"{"downloads":{"outputDir":"   "}}"#,
        )
        .unwrap();
        assert_eq!(
            effective_download_dir(&dir),
            dir.join("data").join("downloads")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn broken_settings_do_not_break_the_uninstaller() {
        let dir = std::env::temp_dir().join("ytd-setup-uninstall-broken");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("data/config")).unwrap();
        std::fs::write(dir.join("data/config/settings.json"), "{ not json").unwrap();
        assert_eq!(
            effective_download_dir(&dir),
            dir.join("data").join("downloads")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
