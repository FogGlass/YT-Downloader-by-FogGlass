fn main() {
    #[cfg(windows)]
    {
        // `tao`/`wry` import ComCtl32 v6-only entry points (`TaskDialogIndirect`,
        // `SetWindowSubclass`, …). `tauri-build` embeds a manifest that requests
        // v6 for the application executable, but test, example and benchmark
        // binaries never see it: without the dependency Windows loads the legacy
        // ComCtl32 v5 and the process dies with STATUS_ENTRYPOINT_NOT_FOUND
        // (0xc0000139) before a single test runs. Declaring the dependency here
        // makes `cargo test` work.
        // `cargo:rustc-link-arg` applies to every linked target, which is what the
        // library's own unit-test harness (and any integration test) needs.
        println!(
            "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
    }

    tauri_build::build()
}
