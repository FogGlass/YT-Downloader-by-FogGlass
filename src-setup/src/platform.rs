//! Windows integration: drives, free space, shortcuts, Add/Remove Programs and
//! process helpers.
//!
//! Everything here avoids third-party crates: disk information comes from the Win32
//! API, shortcuts are created through the shell's COM object from a short PowerShell
//! script, and registry values are written with `reg.exe`. Each helper reports a
//! plain error rather than panicking, because a failed shortcut must never abort an
//! otherwise successful installation.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::SetupError;

/// Folder name created inside the chosen location, and the key used everywhere else.
pub const APP_DIR_NAME: &str = "YT Downloader";
pub const APP_EXE_NAME: &str = "YTDownloader.exe";
pub const UNINSTALLER_NAME: &str = "uninstall.exe";
pub const PRODUCT_NAME: &str = "YT Downloader";
pub const REGISTRY_KEY: &str =
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\YT Downloader";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const DRIVE_FIXED: u32 = 3;

fn hidden(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

// ---------------------------------------------------------------------------
// Disks
// ---------------------------------------------------------------------------

/// Free bytes available to the current user for the volume holding `path`.
pub fn free_space(path: &Path) -> Option<u64> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

        // The directory may not exist yet: walk up to the nearest ancestor that does.
        let mut probe = path.to_path_buf();
        while !probe.exists() {
            match probe.parent() {
                Some(parent) if parent.as_os_str().len() > 0 => probe = parent.to_path_buf(),
                _ => break,
            }
        }

        let mut wide: Vec<u16> = probe.to_string_lossy().encode_utf16().collect();
        wide.push(0);

        let mut available = 0u64;
        let mut total = 0u64;
        let mut total_free = 0u64;
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                wide.as_ptr(),
                &mut available,
                &mut total,
                &mut total_free,
            )
        };
        if ok != 0 {
            return Some(available);
        }
        None
    }

    #[cfg(not(windows))]
    {
        let _ = path;
        None
    }
}

fn drive_root(path: &Path) -> Option<PathBuf> {
    let text = path.to_string_lossy();
    let bytes: Vec<char> = text.chars().collect();
    if bytes.len() >= 2 && bytes[1] == ':' {
        return Some(PathBuf::from(format!("{}:\\", bytes[0].to_ascii_uppercase())));
    }
    None
}

fn is_system_drive(path: &Path) -> bool {
    drive_root(path)
        .map(|root| root.to_string_lossy().to_ascii_uppercase().starts_with("C:"))
        .unwrap_or(false)
}

#[cfg(windows)]
fn drive_is_fixed(root: &Path) -> bool {
    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;

    let mut wide: Vec<u16> = root.to_string_lossy().encode_utf16().collect();
    wide.push(0);
    unsafe { GetDriveTypeW(wide.as_ptr()) == DRIVE_FIXED }
}

#[cfg(not(windows))]
fn drive_is_fixed(_root: &Path) -> bool {
    true
}

/// Every fixed local drive paired with its free space.
fn fixed_drives() -> Vec<(PathBuf, u64)> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Storage::FileSystem::GetLogicalDrives;

        let mask = unsafe { GetLogicalDrives() };
        let mut drives = Vec::new();
        for index in 0..26u32 {
            if mask & (1 << index) == 0 {
                continue;
            }
            let letter = (b'A' + index as u8) as char;
            let root = PathBuf::from(format!("{letter}:\\"));
            if !drive_is_fixed(&root) {
                continue;
            }
            if let Some(free) = free_space(&root) {
                drives.push((root, free));
            }
        }
        drives
    }

    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// Default installation directory.
///
/// The product rule is that installation must never default onto the system drive:
///
/// 1. the drive the installer itself runs from, when it is a fixed non-`C:` volume,
/// 2. otherwise the non-`C:` fixed volume with the most free space,
/// 3. only when no such volume exists, the per-user programs folder.
pub fn default_install_dir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(root) = drive_root(&exe) {
            if !is_system_drive(&root) && drive_is_fixed(&root) {
                return root.join(APP_DIR_NAME);
            }
        }
    }

    let best = fixed_drives()
        .into_iter()
        .filter(|(root, _)| !is_system_drive(root))
        .max_by_key(|(_, free)| *free);

    if let Some((root, _)) = best {
        return root.join(APP_DIR_NAME);
    }

    std::env::var_os("LOCALAPPDATA")
        .map(|base| PathBuf::from(base).join("Programs").join(APP_DIR_NAME))
        .unwrap_or_else(|| PathBuf::from(APP_DIR_NAME))
}

/// Can the installer create files in this directory (now or after creating it)?
pub fn is_writable(directory: &Path) -> bool {
    if std::fs::create_dir_all(directory).is_err() {
        return false;
    }
    let probe = directory.join(".ytd-write-probe");
    match std::fs::write(&probe, b"probe") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

pub fn directory_size(path: &Path) -> u64 {
    if path.is_file() {
        return path.metadata().map(|meta| meta.len()).unwrap_or(0);
    }
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.filter_map(Result::ok) {
            let child = entry.path();
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => total += directory_size(&child),
                Ok(_) => total += entry.metadata().map(|meta| meta.len()).unwrap_or(0),
                Err(_) => {}
            }
        }
    }
    total
}

pub fn remove_path(path: &Path) {
    if path.is_dir() {
        let _ = std::fs::remove_dir_all(path);
    } else if path.exists() {
        if std::fs::remove_file(path).is_err() {
            if let Ok(metadata) = std::fs::metadata(path) {
                let mut permissions = metadata.permissions();
                permissions.set_readonly(false);
                let _ = std::fs::set_permissions(path, permissions);
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Shell locations
// ---------------------------------------------------------------------------

pub fn start_menu_programs() -> Option<PathBuf> {
    std::env::var_os("APPDATA")
        .map(|base| PathBuf::from(base).join(r"Microsoft\Windows\Start Menu\Programs"))
}

pub fn desktop() -> Option<PathBuf> {
    // The Desktop folder can be redirected; ask the shell for the real location.
    if let Some(path) = shell_folder("Desktop") {
        return Some(path);
    }
    std::env::var_os("USERPROFILE").map(|base| PathBuf::from(base).join("Desktop"))
}

/// Resolve a shell folder through .NET, falling back to the environment when
/// PowerShell is unavailable.
fn shell_folder(name: &str) -> Option<PathBuf> {
    let script = format!(
        "[Environment]::GetFolderPath('{name}')"
    );
    let output = hidden(
        Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script]),
    )
    .output()
    .ok()?;

    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(PathBuf::from(text))
    }
}

// ---------------------------------------------------------------------------
// Shortcuts
// ---------------------------------------------------------------------------

pub struct ShortcutSpec<'a> {
    pub lnk: &'a Path,
    pub target: &'a Path,
    pub arguments: &'a str,
    pub working_directory: &'a Path,
    pub description: &'a str,
}

/// Create a `.lnk` through the shell's COM object.
///
/// PowerShell is used rather than a COM crate so the installer carries no extra
/// dependency for a single call; the script is passed base64-encoded to sidestep
/// every quoting pitfall on the way in.
pub fn create_shortcut(spec: &ShortcutSpec<'_>) -> Result<(), SetupError> {
    if let Some(parent) = spec.lnk.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let quote = |value: &str| value.replace('\'', "''");
    let script = format!(
        "$ErrorActionPreference='Stop'\n\
         $shell = New-Object -ComObject WScript.Shell\n\
         $link = $shell.CreateShortcut('{}')\n\
         $link.TargetPath = '{}'\n\
         $link.Arguments = '{}'\n\
         $link.WorkingDirectory = '{}'\n\
         $link.IconLocation = '{},0'\n\
         $link.Description = '{}'\n\
         $link.Save()\n",
        quote(&spec.lnk.to_string_lossy()),
        quote(&spec.target.to_string_lossy()),
        quote(spec.arguments),
        quote(&spec.working_directory.to_string_lossy()),
        quote(&spec.target.to_string_lossy()),
        quote(spec.description),
    );

    let encoded = encode_powershell(&script);
    let output = hidden(
        Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-EncodedCommand",
                &encoded,
            ]),
    )
    .output()
    .map_err(|error| SetupError::Shell(format!("无法调用 PowerShell：{error}")))?;

    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(SetupError::Shell(format!(
            "创建快捷方式失败：{}",
            if detail.is_empty() {
                "PowerShell 返回失败".to_string()
            } else {
                detail
            }
        )));
    }

    Ok(())
}

/// UTF-16LE + base64, the encoding `-EncodedCommand` expects.
fn encode_powershell(script: &str) -> String {
    let mut bytes = Vec::with_capacity(script.len() * 2);
    for unit in script.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    base64(&bytes)
}

fn base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let triple = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        output.push(TABLE[((triple >> 18) & 0x3f) as usize] as char);
        output.push(TABLE[((triple >> 12) & 0x3f) as usize] as char);
        output.push(if chunk.len() > 1 {
            TABLE[((triple >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[(triple & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    output
}

// ---------------------------------------------------------------------------
// Add/Remove Programs
// ---------------------------------------------------------------------------

pub struct UninstallEntry<'a> {
    pub display_version: &'a str,
    pub publisher: &'a str,
    pub install_location: &'a Path,
    pub uninstall_string: &'a str,
    pub icon: &'a Path,
    pub estimated_kib: u64,
    pub install_date: &'a str,
}

pub fn write_uninstall_entry(entry: &UninstallEntry<'_>) -> Result<(), SetupError> {
    // Bound to locals: the `Vec` below borrows these strings, so they must outlive it.
    let install_location = entry.install_location.to_string_lossy().to_string();
    let icon = format!("{},0", entry.icon.to_string_lossy());

    let values: Vec<(&str, &str, &str)> = vec![
        ("DisplayName", "REG_SZ", PRODUCT_NAME),
        ("DisplayVersion", "REG_SZ", entry.display_version),
        ("Publisher", "REG_SZ", entry.publisher),
        ("InstallLocation", "REG_SZ", install_location.as_str()),
        ("UninstallString", "REG_SZ", entry.uninstall_string),
        ("QuietUninstallString", "REG_SZ", entry.uninstall_string),
        ("DisplayIcon", "REG_SZ", icon.as_str()),
        ("InstallDate", "REG_SZ", entry.install_date),
        ("NoModify", "REG_DWORD", "1"),
        ("NoRepair", "REG_DWORD", "1"),
    ];

    for (name, kind, value) in values {
        reg(&["add", REGISTRY_KEY, "/v", name, "/t", kind, "/d", value, "/f"])?;
    }
    reg(&[
        "add",
        REGISTRY_KEY,
        "/v",
        "EstimatedSize",
        "/t",
        "REG_DWORD",
        "/d",
        &entry.estimated_kib.to_string(),
        "/f",
    ])?;

    Ok(())
}

pub fn remove_uninstall_entry() -> Result<(), SetupError> {
    reg(&["delete", REGISTRY_KEY, "/f"])
}

fn reg(args: &[&str]) -> Result<(), SetupError> {
    let output = hidden(Command::new("reg").args(args))
        .output()
        .map_err(|error| SetupError::Shell(format!("无法调用 reg.exe：{error}")))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(SetupError::Shell(format!(
            "注册表操作失败（{}）：{}",
            args.get(1).unwrap_or(&""),
            detail
        )));
    }
    Ok(())
}

/// Read `InstallLocation` back out of the registry (used by the uninstaller when it
/// is asked to run from somewhere other than the install directory).
pub fn read_install_location() -> Option<PathBuf> {
    let output = hidden(Command::new("reg").args(["query", REGISTRY_KEY, "/v", "InstallLocation"]))
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        if line.contains("InstallLocation") {
            if let Some(index) = line.find("REG_SZ") {
                let value = line[index + "REG_SZ".len()..].trim();
                if !value.is_empty() {
                    return Some(PathBuf::from(value));
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

/// Start a program without waiting for it.
pub fn launch_detached(program: &Path, args: &[&str], working_directory: &Path) -> Result<(), SetupError> {
    if !program.exists() {
        return Err(SetupError::Shell(format!(
            "找不到可执行文件：{}",
            program.display()
        )));
    }
    Command::new(program)
        .args(args)
        .current_dir(working_directory)
        .spawn()
        .map_err(|error| SetupError::Shell(format!("无法启动程序：{error}")))?;
    Ok(())
}

pub fn open_in_explorer(path: &Path) -> Result<(), SetupError> {
    if path.is_dir() {
        hidden(Command::new("explorer").arg(path))
            .spawn()
            .map_err(|error| SetupError::Shell(format!("无法打开目录：{error}")))?;
    } else {
        hidden(Command::new("explorer").arg(format!("/select,{}", path.display())))
            .spawn()
            .map_err(|error| SetupError::Shell(format!("无法定位文件：{error}")))?;
    }
    Ok(())
}

/// Delete the running installer/uninstaller and its directory once this process is
/// gone.
///
/// A running executable cannot delete itself, so the work is handed to a detached
/// PowerShell process that waits for this one to exit. The script is passed
/// base64-encoded (`-EncodedCommand`), which sidesteps every quoting pitfall: the
/// install path routinely contains spaces, and `cmd /C "…\"…\"…"` cannot express that
/// reliably.
///
/// `remove_tree` is true only when the uninstaller decided that nothing of the user's
/// remains. When user data was kept, the directory is removed **without** recursion, so
/// it can only disappear if it is genuinely empty — the user's files always keep it
/// alive.
pub fn schedule_self_cleanup(directory: &Path, remove_tree: bool, delete_self: bool) {
    let self_path = std::env::current_exe().unwrap_or_else(|_| directory.join(UNINSTALLER_NAME));
    let quote = |value: &str| value.replace('\'', "''");

    let mut script = String::from("$ErrorActionPreference='SilentlyContinue'\n");
    // Give the parent time to exit and release its file handles.
    script.push_str("Start-Sleep -Seconds 2\n");
    if delete_self {
        script.push_str(&format!(
            "Remove-Item -LiteralPath '{}' -Force\n",
            quote(&self_path.to_string_lossy())
        ));
    }
    if remove_tree {
        script.push_str(&format!(
            "Remove-Item -LiteralPath '{}' -Recurse -Force\n",
            quote(&directory.to_string_lossy())
        ));
    } else {
        // Non-recursive removal: fails harmlessly while any user file is present.
        script.push_str(&format!(
            "Remove-Item -LiteralPath '{}' -Force\n",
            quote(&directory.to_string_lossy())
        ));
    }

    let encoded = encode_powershell(&script);
    let _ = hidden(Command::new("powershell").args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        &encoded,
    ]))
    .current_dir(std::env::temp_dir())
    .spawn();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn the_default_directory_never_targets_the_system_drive() {
        // On this machine the installer runs from a non-C: volume, so the default must
        // follow it. The assertion is written to hold on any machine: either the
        // default is away from C:, or no non-C: fixed volume exists at all.
        let default = default_install_dir();
        let text = default.to_string_lossy().to_ascii_uppercase();
        let has_non_system_volume = fixed_drives()
            .iter()
            .any(|(root, _)| !is_system_drive(root));
        if has_non_system_volume {
            assert!(!text.starts_with("C:"), "默认目录不应落在系统盘：{text}");
        }
        assert!(text.ends_with("YT DOWNLOADER"));
    }

    #[test]
    fn writability_probe_reports_a_real_answer() {
        let dir = std::env::temp_dir().join("ytd-setup-writable");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(is_writable(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn free_space_is_reported_for_an_existing_volume() {
        assert!(free_space(Path::new(r"E:\")).unwrap_or(0) > 0);
    }
}
