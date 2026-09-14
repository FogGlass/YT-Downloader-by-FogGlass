//! Command line handling.
//!
//! The installer is normally interactive. Silent switches exist for the same reason
//! every Windows installer has them: scripted deployment, and verification that can
//! run without a person clicking through a window.
//!
//! ```text
//! YT Downloader Setup.exe                                  interactive install
//! YT Downloader Setup.exe --silent --dir=E:\App            unattended install
//!   [--no-shortcuts] [--no-launch] [--log=path]
//! YT Downloader Setup.exe --uninstall [--silent]           uninstall
//!   [--remove-app-data] [--remove-downloads] [--log=path]
//! ```

use std::path::PathBuf;

#[derive(Debug, Clone, Default)]
pub struct Cli {
    pub uninstall: bool,
    pub silent: bool,
    pub dir: Option<PathBuf>,
    pub no_shortcuts: bool,
    pub no_launch: bool,
    pub remove_app_data: bool,
    pub remove_downloads: bool,
    pub log: Option<PathBuf>,
}

/// Exit codes, so a script can tell the outcomes apart.
pub const EXIT_OK: i32 = 0;
pub const EXIT_FAILED: i32 = 2;
pub const EXIT_CANCELLED: i32 = 3;

impl Cli {
    pub fn parse<I: IntoIterator<Item = String>>(arguments: I) -> Cli {
        let mut cli = Cli::default();

        for argument in arguments {
            let lowered = argument.to_ascii_lowercase();
            match lowered.as_str() {
                "--uninstall" | "/uninstall" | "-uninstall" => cli.uninstall = true,
                "--silent" | "/silent" | "-silent" | "/s" => cli.silent = true,
                "--no-shortcuts" | "/no-shortcuts" => cli.no_shortcuts = true,
                "--no-launch" | "/no-launch" => cli.no_launch = true,
                "--remove-app-data" | "/remove-app-data" => cli.remove_app_data = true,
                "--remove-downloads" | "/remove-downloads" => cli.remove_downloads = true,
                _ => {
                    if let Some(value) = strip_prefix_ci(&argument, "--dir=") {
                        cli.dir = Some(PathBuf::from(value));
                    } else if let Some(value) = strip_prefix_ci(&argument, "--log=") {
                        cli.log = Some(PathBuf::from(value));
                    }
                }
            }
        }

        cli
    }

    /// Append one line to the log file.
    ///
    /// `--log=` wins; in silent mode a log is always written next to the executable so
    /// an unattended run can be diagnosed even when the argument list was mangled by
    /// whatever launched it (an unquoted path with spaces, for instance).
    pub fn log(&self, message: &str) {
        use std::io::Write;

        let path = self.log.clone().or_else(|| {
            if !self.silent {
                return None;
            }
            std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(|dir| dir.join("setup-log.txt")))
        });

        let Some(path) = path else {
            return;
        };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(mut handle) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(handle, "{} {message}", timestamp());
        }
    }
}

fn strip_prefix_ci(value: &str, prefix: &str) -> Option<String> {
    if value.len() >= prefix.len() && value[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(value[prefix.len()..].to_string())
    } else {
        None
    }
}

/// Wall-clock stamp for log lines, without pulling in a date crate.
fn timestamp() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let hours = (seconds / 3600) % 24;
    let minutes = (seconds / 60) % 60;
    let secs = seconds % 60;
    format!("[{hours:02}:{minutes:02}:{secs:02}]")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Cli {
        Cli::parse(args.iter().map(|value| value.to_string()))
    }

    #[test]
    fn no_arguments_means_an_interactive_install() {
        let cli = parse(&[]);
        assert!(!cli.uninstall);
        assert!(!cli.silent);
        assert!(cli.dir.is_none());
    }

    #[test]
    fn silent_install_arguments_are_understood() {
        let cli = parse(&["--silent", r"--dir=E:\YT Downloader", "--no-launch"]);
        assert!(cli.silent);
        assert!(!cli.uninstall);
        assert_eq!(cli.dir, Some(PathBuf::from(r"E:\YT Downloader")));
        assert!(cli.no_launch);
        assert!(!cli.no_shortcuts);
    }

    #[test]
    fn uninstall_arguments_are_understood() {
        let cli = parse(&["--uninstall", "/S", "--remove-app-data", "--remove-downloads"]);
        assert!(cli.uninstall);
        assert!(cli.silent);
        assert!(cli.remove_app_data);
        assert!(cli.remove_downloads);
    }

    #[test]
    fn switches_are_case_insensitive() {
        assert!(parse(&["--UNINSTALL"]).uninstall);
        assert!(parse(&["--Silent"]).silent);
        assert_eq!(
            parse(&["--DIR=D:\\Apps"]).dir,
            Some(PathBuf::from(r"D:\Apps"))
        );
    }

    #[test]
    fn unknown_arguments_are_ignored() {
        let cli = parse(&["--nonsense", "--dir"]);
        assert!(cli.dir.is_none());
        assert!(!cli.silent);
    }
}
