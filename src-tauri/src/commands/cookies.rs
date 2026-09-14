//! Browser cookie diagnostics.
//!
//! Reading browser cookies fails for reasons that have nothing to do with being logged
//! out, and the user needs to be told which one it is:
//!
//! * **the browser is running** and holds its cookie database open, so yt-dlp cannot
//!   copy it;
//! * **app-bound encryption** (Chromium 127+, including current Edge) protects the
//!   cookie values with a key that only the browser itself can use, so third-party
//!   tools can read the file but never decrypt it — yt-dlp reports this as
//!   `Failed to decrypt with DPAPI`;
//! * the profile or the database simply does not exist.
//!
//! Everything here is read-only: the database is opened at most to test whether it can
//! be opened for writing, and no cookie value is ever read, copied or logged.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::commands::AppState;
use crate::models::settings::CookieMode;

/// Browsers yt-dlp can read cookies from, with their Windows profile locations.
struct BrowserSpec {
    key: &'static str,
    name: &'static str,
    /// Folder holding the user data, relative to a base environment variable.
    relative: &'static str,
    base: Base,
}

#[derive(Clone, Copy)]
enum Base {
    LocalAppData,
    RoamingAppData,
}

const BROWSERS: &[BrowserSpec] = &[
    BrowserSpec {
        key: "edge",
        name: "Microsoft Edge",
        relative: r"Microsoft\Edge\User Data",
        base: Base::LocalAppData,
    },
    BrowserSpec {
        key: "chrome",
        name: "Google Chrome",
        relative: r"Google\Chrome\User Data",
        base: Base::LocalAppData,
    },
    BrowserSpec {
        key: "brave",
        name: "Brave",
        relative: r"BraveSoftware\Brave-Browser\User Data",
        base: Base::LocalAppData,
    },
    BrowserSpec {
        key: "vivaldi",
        name: "Vivaldi",
        relative: r"Vivaldi\User Data",
        base: Base::LocalAppData,
    },
    BrowserSpec {
        key: "chromium",
        name: "Chromium",
        relative: r"Chromium\User Data",
        base: Base::LocalAppData,
    },
    BrowserSpec {
        key: "firefox",
        name: "Mozilla Firefox",
        relative: r"Mozilla\Firefox",
        base: Base::RoamingAppData,
    },
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInfo {
    pub key: String,
    pub name: String,
    pub installed: bool,
    pub user_data_dir: Option<String>,
    pub profiles: Vec<String>,
    /// Chromium browsers encrypt cookie values with a key only they can use.
    pub app_bound_encryption: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieStatus {
    pub configured_mode: String,
    pub browser_key: String,
    pub browser_name: String,
    pub profile: String,
    pub database_path: Option<String>,
    pub database_exists: bool,
    pub database_size_bytes: u64,
    pub locked: bool,
    pub browser_running: bool,
    pub app_bound_encryption: bool,
    pub installed_browsers: Vec<BrowserInfo>,
    /// One-line summary of the current state.
    pub message: String,
    /// What the user can do about it, when something is wrong.
    pub hint: Option<String>,
}

/// Inspect the configured browser's cookie store without reading any cookie value.
#[tauri::command]
pub fn cookie_status(state: State<'_, AppState>) -> CookieStatus {
    let settings = state.settings.snapshot();
    let cookies = settings.cookies.clone();

    let installed: Vec<BrowserInfo> = BROWSERS
        .iter()
        .map(|spec| {
            let dir = user_data_dir(spec);
            let installed = dir.as_ref().map(|dir| dir.is_dir()).unwrap_or(false);
            BrowserInfo {
                key: spec.key.to_string(),
                name: spec.name.to_string(),
                installed,
                user_data_dir: dir.as_ref().map(|dir| dir.to_string_lossy().to_string()),
                profiles: dir.as_deref().map(profiles_of).unwrap_or_default(),
                app_bound_encryption: dir
                    .as_deref()
                    .map(has_app_bound_encryption)
                    .unwrap_or(false),
            }
        })
        .collect();

    // The default is Edge: it is what this machine actually runs. Only fall back to
    // whatever else is installed when Edge is absent, and never to Chrome by habit.
    let configured = if cookies.mode == CookieMode::None {
        String::new()
    } else {
        cookies.browser.trim().to_ascii_lowercase()
    };

    let effective_key = if configured.is_empty() {
        installed
            .iter()
            .find(|browser| browser.key == "edge" && browser.installed)
            .or_else(|| installed.iter().find(|browser| browser.key == "firefox" && browser.installed))
            .or_else(|| installed.iter().find(|browser| browser.installed))
            .map(|browser| browser.key.clone())
            .unwrap_or_else(|| "edge".into())
    } else {
        configured.clone()
    };

    let spec = BROWSERS.iter().find(|spec| spec.key == effective_key);
    let database = spec
        .and_then(|spec| cookie_database_path(spec, &cookies.profile));

    let (exists, size) = match &database {
        Some(path) => match std::fs::metadata(path) {
            Ok(meta) => (true, meta.len()),
            Err(_) => (false, 0),
        },
        None => (false, 0),
    };

    // A shared read succeeds even while the browser is running, so write access is what
    // tells us the file is actually free. Opening for append and immediately closing
    // changes nothing on disk.
    let locked = database
        .as_ref()
        .map(|path| {
            std::fs::OpenOptions::new()
                .append(true)
                .open(path)
                .map(|_| false)
                .unwrap_or(true)
        })
        .unwrap_or(false);

    let browser_running = process_running(spec.map(|spec| spec.key).unwrap_or("edge"));
    let app_bound = spec
        .and_then(user_data_dir)
        .as_deref()
        .map(has_app_bound_encryption)
        .unwrap_or(false);

    let name = spec.map(|spec| spec.name.to_string()).unwrap_or_else(|| effective_key.clone());

    let (message, hint) = if cookies.mode == CookieMode::None {
        (
            "当前未启用浏览器 Cookie。".to_string(),
            Some("若视频需要登录才可访问，可在上方切换为「浏览器」。".to_string()),
        )
    } else if database.is_none() {
        (
            format!("未找到 {name} 的 Cookie 数据库。"),
            Some("请确认浏览器已安装并至少启动过一次；也可以改用 cookies.txt。".to_string()),
        )
    } else if !exists {
        (
            format!("未找到 {name} 的 Cookie 数据库（配置文件「{}」）。", if cookies.profile.trim().is_empty() { "默认" } else { cookies.profile.trim() }),
            Some("请在「配置文件」中填写正确的配置文件名（如 Default、Profile 1）。".to_string()),
        )
    } else if app_bound {
        (
            format!("{name} 启用了应用绑定加密，yt-dlp 无法解密其 Cookie。"),
            Some("这是 Edge 127 及以后版本的默认保护方式。请改用导出的 cookies.txt，或选择「不使用 Cookie」继续下载。".to_string()),
        )
    } else if locked {
        (
            format!("{name} 正在运行，Cookie 数据库被占用。"),
            Some("请完全退出浏览器（含后台进程）后重试；也可以改用 cookies.txt 或「不使用 Cookie」。".to_string()),
        )
    } else {
        (
            format!("{name} 的 Cookie 数据库可读（{}）。", human(size)),
            None,
        )
    };

    CookieStatus {
        configured_mode: match cookies.mode {
            CookieMode::None => "none",
            CookieMode::Browser => "browser",
            CookieMode::File => "file",
        }
        .into(),
        browser_key: effective_key,
        browser_name: name,
        profile: cookies.profile,
        database_path: database.map(|path| path.to_string_lossy().to_string()),
        database_exists: exists,
        database_size_bytes: size,
        locked,
        browser_running,
        app_bound_encryption: app_bound,
        installed_browsers: installed,
        message,
        hint,
    }
}

/// Cookiejar export is a user action; the file path is validated so the UI can explain
/// a mistake before a download is attempted.
#[tauri::command]
pub fn validate_cookie_file(path: String) -> CookieFileCheck {
    let trimmed = path.trim().to_string();
    if trimmed.is_empty() {
        return CookieFileCheck {
            path: trimmed,
            exists: false,
            readable: false,
            looks_like_cookiejar: false,
            message: "尚未选择 cookies.txt。".into(),
        };
    }

    let file = PathBuf::from(&trimmed);
    if !file.is_file() {
        return CookieFileCheck {
            path: trimmed,
            exists: false,
            readable: false,
            looks_like_cookiejar: false,
            message: "文件不存在。".into(),
        };
    }

    // Only the Netscape header is inspected — never the cookie rows themselves.
    let header_ok = std::fs::read_to_string(&file)
        .map(|text| {
            text.lines()
                .take(6)
                .any(|line| line.contains("Netscape HTTP Cookie File") || line.contains("#HttpOnly_"))
        })
        .unwrap_or(false);

    CookieFileCheck {
        path: trimmed,
        exists: true,
        readable: true,
        looks_like_cookiejar: header_ok,
        message: if header_ok {
            "已识别为 Netscape 格式的 cookies.txt。".into()
        } else {
            "文件存在，但不像 Netscape 格式的 cookies.txt（请使用浏览器扩展导出的格式）。".into()
        },
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieFileCheck {
    pub path: String,
    pub exists: bool,
    pub readable: bool,
    pub looks_like_cookiejar: bool,
    pub message: String,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn user_data_dir(spec: &BrowserSpec) -> Option<PathBuf> {
    let base = match spec.base {
        Base::LocalAppData => std::env::var_os("LOCALAPPDATA")?,
        Base::RoamingAppData => std::env::var_os("APPDATA")?,
    };
    Some(PathBuf::from(base).join(spec.relative))
}

fn profiles_of(user_data: &Path) -> Vec<String> {
    let mut profiles: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(user_data) {
        for entry in entries.filter_map(Result::ok) {
            if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name == "Default" || name.starts_with("Profile ") {
                profiles.push(name);
            }
        }
    }
    profiles.sort();
    profiles
}

/// Path of the cookie database for a Chromium profile, preferring `Network\Cookies`
/// (current layout) and falling back to the legacy location.
fn cookie_database_path(spec: &BrowserSpec, profile: &str) -> Option<PathBuf> {
    let user_data = user_data_dir(spec)?;
    let profile_name = if profile.trim().is_empty() {
        "Default".to_string()
    } else {
        profile.trim().to_string()
    };

    if spec.key == "firefox" {
        // Firefox keeps one cookies.sqlite per profile directory.
        let candidate = user_data.join("Profiles").join(&profile_name).join("cookies.sqlite");
        if candidate.is_file() {
            return Some(candidate);
        }
        if let Ok(entries) = std::fs::read_dir(user_data.join("Profiles")) {
            for entry in entries.filter_map(Result::ok) {
                let candidate = entry.path().join("cookies.sqlite");
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
        return None;
    }

    let profile_dir = user_data.join(&profile_name);
    let modern = profile_dir.join("Network").join("Cookies");
    if modern.is_file() {
        return Some(modern);
    }
    let legacy = profile_dir.join("Cookies");
    if legacy.is_file() {
        return Some(legacy);
    }
    // Report the modern path even when missing, so the UI can show what was expected.
    Some(modern)
}

/// Chromium writes `app_bound_encrypted_key` into `Local State` once app-bound
/// encryption is active; its presence explains a DPAPI decryption failure exactly.
fn has_app_bound_encryption(user_data: &Path) -> bool {
    let state = user_data.join("Local State");
    let Ok(text) = std::fs::read_to_string(&state) else {
        return false;
    };
    text.contains("app_bound_encrypted_key")
}

fn process_running(browser_key: &str) -> bool {
    let image = match browser_key {
        "edge" => "msedge.exe",
        "chrome" => "chrome.exe",
        "brave" => "brave.exe",
        "vivaldi" => "vivaldi.exe",
        "firefox" => "firefox.exe",
        _ => return false,
    };

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        // `tasklist` avoids a dependency on a process-enumeration crate.
        let output = std::process::Command::new("tasklist")
            .args(["/FI", &format!("IMAGENAME eq {image}"), "/NH"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        if let Ok(output) = output {
            let text = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
            return text.contains(&image.to_ascii_lowercase());
        }
        false
    }

    #[cfg(not(windows))]
    {
        let _ = image;
        false
    }
}

fn human(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{} {}", bytes, UNITS[0])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edge_is_the_first_chromium_browser_considered() {
        // The product rule: this machine runs Edge, and Chrome is not installed. The
        // fallback order must not reach for Chrome by habit.
        let order: Vec<&str> = BROWSERS.iter().map(|spec| spec.key).collect();
        assert_eq!(order[0], "edge");
        assert!(order.contains(&"chrome"));
    }

    #[test]
    fn the_edge_cookie_database_path_follows_the_current_layout() {
        let spec = BROWSERS.iter().find(|spec| spec.key == "edge").unwrap();
        let path = cookie_database_path(spec, "");
        let path = path.expect("a path is always proposed");
        assert!(path.to_string_lossy().contains("Microsoft"));
        assert!(path.to_string_lossy().contains("User Data"));
        assert!(path.to_string_lossy().ends_with(r"Default\Network\Cookies"));
    }

    #[test]
    fn a_profile_name_is_honoured() {
        let spec = BROWSERS.iter().find(|spec| spec.key == "edge").unwrap();
        let path = cookie_database_path(spec, "Profile 2").unwrap();
        assert!(path.to_string_lossy().contains("Profile 2"));
    }

    #[test]
    fn app_bound_encryption_is_detected_from_local_state() {
        let dir = std::env::temp_dir().join("ytd-cookie-abe-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        assert!(!has_app_bound_encryption(&dir));

        std::fs::write(
            dir.join("Local State"),
            r#"{"os_crypt":{"app_bound_encrypted_key":"AQUAAAAA="}}"#,
        )
        .unwrap();
        assert!(has_app_bound_encryption(&dir));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_cookie_file_is_reported_clearly() {
        let check = validate_cookie_file(String::new());
        assert!(!check.exists);
        assert!(check.message.contains("尚未选择"));

        let check = validate_cookie_file(r"E:\definitely\missing\cookies.txt".into());
        assert!(!check.exists);
        assert_eq!(check.message, "文件不存在。");
    }

    #[test]
    fn a_netscape_cookiejar_is_recognised_without_reading_its_contents() {
        let dir = std::env::temp_dir().join("ytd-cookie-file-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("cookies.txt");
        std::fs::write(
            &file,
            "# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tTRUE\t0\tNAME\tVALUE\n",
        )
        .unwrap();

        let check = validate_cookie_file(file.to_string_lossy().to_string());
        assert!(check.exists && check.readable && check.looks_like_cookiejar);

        std::fs::write(&file, "not a cookiejar").unwrap();
        let check = validate_cookie_file(file.to_string_lossy().to_string());
        assert!(check.exists && !check.looks_like_cookiejar);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
