//! Opt-in live check for "reveal in Explorer".
//!
//! Explorer's window state cannot be asserted from inside the process that launched it, so
//! this check only performs the reveal; the folder and the selected item are then read back
//! through the shell's own automation interface (`Shell.Application`), which is what
//! `scripts/verify-reveal.ps1` does. Without `YTD_REVEAL_PATH` the test does nothing, so a
//! normal `cargo test` never opens a window on the developer's desktop.
//!
//! Usage:
//!   $env:YTD_REVEAL_PATH = 'D:\Downloads\YouTube Videos\test video.mp4'
//!   cargo test --test reveal_probe -- --nocapture

use std::path::Path;

#[test]
fn reveal_the_path_named_by_the_environment() {
    let Ok(path) = std::env::var("YTD_REVEAL_PATH") else {
        eprintln!("YTD_REVEAL_PATH not set — skipping the live reveal check");
        return;
    };

    yt_downloader_lib::core::fs_util::shell_reveal(Path::new(&path)).expect("reveal the file");

    // Leave the window open long enough for the external inspection to observe it.
    std::thread::sleep(std::time::Duration::from_millis(2000));
}
