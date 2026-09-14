fn main() {
    #[cfg(windows)]
    {
        // ComCtl32 v6 entry points are imported by `tao`/`wry`; see the note in the
        // main application's build script.
        println!(
            "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
    }

    tauri_build::build()
}
