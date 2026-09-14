//! Installation.
//!
//! Steps: validate the target → extract the payload → create shortcuts → register the
//! uninstall information → optionally launch. Failure at any point rolls back what was
//! already written, so a failed install never leaves a half-installed application.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::platform::{self, ShortcutSpec};
use crate::progress::{ProgressReporter, SetupFinished};
use crate::payload::Payload;
use crate::{SetupError, SetupState};

/// Install steps, in order. The percentages below are anchored on these.
const STEPS: &[(&str, &str)] = &[
    ("prepare", "检查安装目录"),
    ("extract", "解压程序文件与内置运行库"),
    ("shortcuts", "创建快捷方式"),
    ("register", "写入卸载信息"),
    ("finalize", "完成安装"),
];

/// Fraction of the progress bar consumed by each phase.
const PREPARE_END: f64 = 0.04;
const EXTRACT_END: f64 = 0.90;
const SHORTCUTS_END: f64 = 0.94;
const REGISTER_END: f64 = 0.99;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOptions {
    pub dir: String,
    pub start_menu_shortcut: bool,
    pub desktop_shortcut: bool,
    pub launch_after_install: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    pub install_dir: PathBuf,
    pub shortcuts: Vec<PathBuf>,
    pub warnings: Vec<String>,
}

pub fn run_install(
    app: AppHandle,
    state: Arc<SetupState>,
    options: InstallOptions,
) -> Result<InstallOutcome, SetupError> {
    let mut reporter = ProgressReporter::new(app, "install", STEPS);
    let mut warnings: Vec<String> = Vec::new();
    let mut created_shortcuts: Vec<PathBuf> = Vec::new();
    let destination = PathBuf::from(options.dir.trim());

    // ---- 1. validate ------------------------------------------------------
    reporter.begin(0, "正在检查安装目录…");
    validate_target(&destination)?;
    if !platform::is_writable(&destination) {
        return Err(SetupError::Message(format!(
            "目录不可写：{}。请选择其他位置，或以管理员身份运行。",
            destination.display()
        )));
    }

    let payload = Payload::open_self()?;
    let required = payload.extracted_bytes;
    if let Some(free) = platform::free_space(&destination) {
        // Keep a small margin so the extraction cannot fill the volume completely.
        if free < required + 64 * 1024 * 1024 {
            return Err(SetupError::Message(format!(
                "目标磁盘空间不足：需要约 {}，可用 {}。",
                human(required + 64 * 1024 * 1024),
                human(free)
            )));
        }
    }
    reporter.complete(0);

    // ---- 2. extract -------------------------------------------------------
    let result = (|| -> Result<(), SetupError> {
        reporter.begin(
            1,
            &format!("正在解压 {} 个文件…", payload.file_count()),
        );

        let extracted = payload.extract(&destination, &state.cancel, &mut |written, name| {
            let ratio = if required == 0 {
                1.0
            } else {
                written as f64 / required as f64
            };
            let percent = PREPARE_END + ratio * (EXTRACT_END - PREPARE_END);
            reporter.set(percent, name);
        })?;
        let _ = extracted;

        // The payload container stores files only (an empty directory cannot be
        // represented), so the application's data skeleton is created here. This also
        // guarantees a pristine layout: no settings, logs or caches from the machine
        // the installer was built on can ever travel inside it.
        for folder in [
            "config",
            "history",
            "favorites",
            "logs",
            "cache",
            "temp",
            "downloads",
            "webview",
        ] {
            std::fs::create_dir_all(destination.join("data").join(folder))?;
        }
        reporter.complete(1);

        // ---- 3. shortcuts -------------------------------------------------
        reporter.begin(2, "正在创建快捷方式…");
        let app_exe = destination.join(platform::APP_EXE_NAME);
        let uninstaller = destination.join(platform::UNINSTALLER_NAME);

        if let Err(error) = write_uninstaller_stub(&destination) {
            warnings.push(format!("写入卸载程序失败：{error}"));
        }

        if options.start_menu_shortcut {
            match start_menu_folder() {
                Some(folder) => {
                    if let Err(error) = std::fs::create_dir_all(&folder) {
                        warnings.push(format!("无法创建开始菜单文件夹：{error}"));
                    } else {
                        let app_lnk = folder.join("YT Downloader.lnk");
                        match platform::create_shortcut(&ShortcutSpec {
                            lnk: &app_lnk,
                            target: &app_exe,
                            arguments: "",
                            working_directory: &destination,
                            description: "YT Downloader",
                        }) {
                            Ok(()) => created_shortcuts.push(app_lnk),
                            Err(error) => warnings.push(error.to_string()),
                        }

                        let uninstall_lnk = folder.join("卸载 YT Downloader.lnk");
                        match platform::create_shortcut(&ShortcutSpec {
                            lnk: &uninstall_lnk,
                            target: &uninstaller,
                            arguments: "--uninstall",
                            working_directory: &destination,
                            description: "卸载 YT Downloader",
                        }) {
                            Ok(()) => created_shortcuts.push(uninstall_lnk),
                            Err(error) => warnings.push(error.to_string()),
                        }
                    }
                }
                None => warnings.push("无法定位开始菜单目录，已跳过快捷方式。".into()),
            }
        }

        if options.desktop_shortcut {
            match platform::desktop() {
                Some(folder) => {
                    let lnk = folder.join("YT Downloader.lnk");
                    match platform::create_shortcut(&ShortcutSpec {
                        lnk: &lnk,
                        target: &app_exe,
                        arguments: "",
                        working_directory: &destination,
                        description: "YT Downloader",
                    }) {
                        Ok(()) => created_shortcuts.push(lnk),
                        Err(error) => warnings.push(error.to_string()),
                    }
                }
                None => warnings.push("无法定位桌面目录，已跳过桌面快捷方式。".into()),
            }
        }
        reporter.set(SHORTCUTS_END, "快捷方式已创建");
        reporter.complete(2);

        // ---- 4. Add/Remove Programs ---------------------------------------
        reporter.begin(3, "正在写入卸载信息…");
        let size_kib = platform::directory_size(&destination) / 1024;
        let uninstall_string = format!("\"{}\" --uninstall", uninstaller.display());
        platform::write_uninstall_entry(&platform::UninstallEntry {
            display_version: env!("CARGO_PKG_VERSION"),
            publisher: platform::PRODUCT_NAME,
            install_location: &destination,
            uninstall_string: &uninstall_string,
            icon: &app_exe,
            estimated_kib: size_kib,
            install_date: &chrono_stamp(),
        })?;
        reporter.set(REGISTER_END, "卸载信息已写入");
        reporter.complete(3);

        // ---- 5. done -------------------------------------------------------
        reporter.begin(4, "正在完成安装…");
        reporter.set(REGISTER_END + 0.005, "安装完成");
        reporter.complete(4);
        Ok(())
    })();

    match result {
        Ok(()) => {
            if options.launch_after_install {
                let app_exe = destination.join(platform::APP_EXE_NAME);
                if let Err(error) = platform::launch_detached(&app_exe, &[], &destination) {
                    warnings.push(format!("安装已完成，但自动启动失败：{error}"));
                }
            }
            reporter.set(1.0, "安装完成");
            reporter.finish(SetupFinished {
                ok: true,
                mode: "install".into(),
                install_dir: Some(destination.to_string_lossy().to_string()),
                error: None,
                detail: if warnings.is_empty() {
                    None
                } else {
                    Some(warnings.join("\n"))
                },
                app_data_kept: false,
                downloads_kept: false,
                kept_data_path: None,
            });
            Ok(InstallOutcome {
                install_dir: destination,
                shortcuts: created_shortcuts,
                warnings,
            })
        }
        Err(error) => {
            // Roll back: a failed install must not leave a half-written application.
            let cancelled = matches!(error, SetupError::Cancelled);
            for lnk in &created_shortcuts {
                platform::remove_path(lnk);
            }
            if let Some(folder) = start_menu_folder() {
                // Only removes the folder when the uninstaller already emptied it.
                let _ = std::fs::remove_dir(&folder);
            }
            let _ = platform::remove_uninstall_entry();
            cleanup_install(&destination);

            let summary = if cancelled {
                "安装已取消".to_string()
            } else {
                format!("安装失败：{error}")
            };
            reporter.finish(SetupFinished {
                ok: false,
                mode: "install".into(),
                install_dir: Some(destination.to_string_lossy().to_string()),
                error: Some(summary),
                detail: Some(error.to_string()),
                app_data_kept: false,
                downloads_kept: false,
                kept_data_path: None,
            });
            Err(error)
        }
    }
}

/// Remove everything the installer may have written, but never the whole directory
/// blindly: only entries this installer created are deleted.
fn cleanup_install(destination: &Path) {
    for name in [
        platform::APP_EXE_NAME,
        platform::UNINSTALLER_NAME,
        "README.txt",
        "runtime",
        "data",
    ] {
        platform::remove_path(&destination.join(name));
    }
    let _ = std::fs::remove_dir(destination);
}

/// Guards against installing into a location that would be destructive or nonsensical.
pub fn validate_target(destination: &Path) -> Result<(), SetupError> {
    let text = destination.to_string_lossy().to_string();
    if text.trim().is_empty() {
        return Err(SetupError::Message("安装目录不能为空。".into()));
    }
    if !destination.is_absolute() {
        return Err(SetupError::Message("请选择完整的绝对路径。".into()));
    }
    // A drive root would put the application's files among unrelated ones.
    if destination.parent().is_none() {
        return Err(SetupError::Message(
            "请不要直接安装到磁盘根目录，请选择一个文件夹。".into(),
        ));
    }
    let lowered = text.to_ascii_lowercase();
    for forbidden in [
        r"c:\windows",
        r"c:\program files\windows",
        r"c:\program files (x86)\windows",
    ] {
        if lowered.starts_with(forbidden) {
            return Err(SetupError::Message(
                "该位置属于系统目录，安装程序不会写入这里。".into(),
            ));
        }
    }
    Ok(())
}

/// Copy only the stub portion of the running installer to `uninstall.exe`.
///
/// The payload is a multi-hundred-megabyte prefix of this executable; the uninstaller
/// never reads it, so shipping a payload-free copy keeps the installed footprint small.
fn write_uninstaller_stub(destination: &Path) -> Result<(), SetupError> {
    let self_path = std::env::current_exe()?;
    let payload = Payload::open_self()?;
    let stub_len = payload.stub_len();

    let mut source = File::open(&self_path)?;
    let mut target = File::create(destination.join(platform::UNINSTALLER_NAME))?;

    let mut remaining = stub_len;
    let mut buffer = vec![0u8; 256 * 1024];
    while remaining > 0 {
        let want = buffer.len().min(remaining as usize);
        let read = source.read(&mut buffer[..want])?;
        if read == 0 {
            break;
        }
        target.write_all(&buffer[..read])?;
        remaining -= read as u64;
    }
    target.flush()?;
    Ok(())
}

/// Start Menu folder dedicated to the product.
fn start_menu_folder() -> Option<PathBuf> {
    platform::start_menu_programs().map(|base| base.join(platform::APP_DIR_NAME))
}

fn chrono_stamp() -> String {
    // `InstallDate` is informational only, and the civil-date conversion below avoids
    // pulling in a date crate (or another Win32 import) for one string.
    let days = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| (elapsed.as_secs() / 86_400) as i64)
        .unwrap_or(0);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}{month:02}{day:02}")
}

/// Days since 1970-01-01 → (year, month, day). Howard Hinnant's algorithm.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
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

/// Kept for symmetry with the uninstaller; ensures the cancel flag is observable.
pub fn is_cancelled(state: &SetupState) -> bool {
    state.cancel.load(Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_dates_are_converted_correctly() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        assert_eq!(civil_from_days(20_000), (2024, 10, 4));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
    }

    #[test]
    fn sizes_are_humanised() {
        assert_eq!(human(512), "512 B");
        assert_eq!(human(2048), "2.0 KB");
        assert_eq!(human(5 * 1024 * 1024), "5.0 MB");
    }

    #[test]
    fn drive_roots_and_system_directories_are_refused() {
        assert!(validate_target(Path::new(r"E:\")).is_err());
        assert!(validate_target(Path::new(r"C:\Windows\System32")).is_err());
        assert!(validate_target(Path::new(r"C:\Program Files\Windows Apps")).is_err());
        assert!(validate_target(Path::new(r"E:\YT Downloader")).is_ok());
        assert!(validate_target(Path::new("relative\\path")).is_err());
        assert!(validate_target(Path::new("")).is_err());
    }
}
