//! URL validation and media probing.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::AppState;
use crate::core::error::{AppError, AppResult};
use crate::models::media::MediaProbe;
use crate::runtime;
use crate::services::ytdlp;
use crate::log_info;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UrlCheck {
    pub url: String,
    pub valid: bool,
    pub reason: Option<String>,
    pub playlist: bool,
}

/// Validate a pasted blob of text and return one entry per candidate URL.
///
/// Duplicates are collapsed: pasting the same link twice must not create two tasks.
#[tauri::command]
pub fn validate_urls(text: String) -> Vec<UrlCheck> {
    let mut checks: Vec<UrlCheck> = Vec::new();

    for raw in text.lines() {
        let candidate = raw.trim();
        if candidate.is_empty() {
            continue;
        }
        // A line may contain surrounding prose; take the first URL-looking token.
        let candidate = candidate
            .split_whitespace()
            .find(|token| token.starts_with("http://") || token.starts_with("https://"))
            .unwrap_or(candidate);

        let check = match url::Url::parse(candidate) {
            Ok(parsed) => {
                let scheme_ok = matches!(parsed.scheme(), "http" | "https");
                let host_ok = parsed.host_str().map(|host| host.contains('.')).unwrap_or(false);
                if !scheme_ok {
                    UrlCheck {
                        url: candidate.to_string(),
                        valid: false,
                        reason: Some("仅支持 http / https 链接".into()),
                        playlist: false,
                    }
                } else if !host_ok {
                    UrlCheck {
                        url: candidate.to_string(),
                        valid: false,
                        reason: Some("链接缺少有效的主机名".into()),
                        playlist: false,
                    }
                } else {
                    UrlCheck {
                        url: parsed.to_string(),
                        valid: true,
                        reason: None,
                        playlist: ytdlp::is_playlist_url(candidate),
                    }
                }
            }
            Err(_) => UrlCheck {
                url: candidate.to_string(),
                valid: false,
                reason: Some("不是有效的链接".into()),
                playlist: false,
            },
        };

        if !checks.iter().any(|existing| existing.url == check.url) {
            checks.push(check);
        }
    }

    checks
}

/// Probe one URL and return everything the UI needs to render it.
///
/// `ignore_cookies` re-runs the parse without browser cookies — the fallback offered
/// when the browser's cookie store cannot be read or decrypted.
#[tauri::command]
pub async fn probe_url(
    state: State<'_, AppState>,
    url: String,
    playlist: Option<bool>,
    ignore_cookies: Option<bool>,
) -> AppResult<MediaProbe> {
    let settings = state.settings.snapshot();
    let tools = runtime::resolve(&settings);
    let is_playlist = playlist.unwrap_or_else(|| ytdlp::is_playlist_url(&url));
    let without_cookies = ignore_cookies.unwrap_or(false);

    // Report what yt-dlp will actually receive: "configured" only when a cookie argument is
    // really built. Feeding a browser name or a cookies.txt path that is empty produces no
    // argument at all, and saying "configured" then hides that from the log.
    let cookie_state = if without_cookies {
        "skipped"
    } else if ytdlp::cookies_are_effective(&settings) {
        "configured"
    } else {
        "none"
    };

    log_info!(
        "probe",
        "probing {url} (playlist={is_playlist}, cookies={cookie_state})"
    );

    let probe = ytdlp::probe(
        &settings,
        &state.roots,
        &tools,
        state.registry.clone(),
        &url,
        is_playlist,
        without_cookies,
    )
    .await?;

    if probe.formats.is_empty() && probe.entries.is_empty() {
        return Err(AppError::Runtime(
            "没有从该链接解析到任何可下载内容".into(),
        ));
    }

    Ok(probe)
}

/// Probe every entry of a playlist or channel, for the batch queue.
#[tauri::command]
pub async fn probe_playlist(
    state: State<'_, AppState>,
    url: String,
    limit: Option<u32>,
    ignore_cookies: Option<bool>,
) -> AppResult<MediaProbe> {
    let settings = state.settings.snapshot();
    let tools = runtime::resolve(&settings);

    let mut probe = ytdlp::probe(
        &settings,
        &state.roots,
        &tools,
        state.registry.clone(),
        &url,
        true,
        ignore_cookies.unwrap_or(false),
    )
    .await?;

    if let Some(limit) = limit.filter(|value| *value > 0) {
        probe.entries.truncate(limit as usize);
    }

    Ok(probe)
}

/// Cancel a running probe (the parse button turns into a stop button).
#[tauri::command]
pub fn cancel_probe(state: State<'_, AppState>) -> bool {
    state.registry.cancel("probe")
}

/// The URL schemes the paste box accepts, surfaced so the UI and backend agree.
#[tauri::command]
pub fn supported_link_examples() -> Vec<String> {
    vec![
        "https://www.youtube.com/watch?v=…".into(),
        "https://youtu.be/…".into(),
        "https://www.youtube.com/shorts/…".into(),
        "https://www.youtube.com/playlist?list=…".into(),
        "https://www.youtube.com/@channel/videos".into(),
    ]
}

/// Used by tests and by the About page to show where data lives.
#[tauri::command]
pub fn data_root(state: State<'_, AppState>) -> String {
    state.roots.root.to_string_lossy().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_video_links_are_valid_and_not_playlists() {
        let checks = validate_urls("https://www.youtube.com/watch?v=aqz-KE-bpKQ".into());
        assert_eq!(checks.len(), 1);
        assert!(checks[0].valid);
        assert!(!checks[0].playlist);
    }

    #[test]
    fn playlists_channels_and_shorts_are_detected() {
        let checks = validate_urls(
            "https://www.youtube.com/playlist?list=PL123\nhttps://www.youtube.com/@Someone/videos\nhttps://www.youtube.com/shorts/abc123\nhttps://youtu.be/xyz".into(),
        );
        assert_eq!(checks.len(), 4);
        assert!(checks[0].playlist);
        assert!(checks[1].playlist);
        assert!(!checks[2].playlist);
        assert!(checks[3].valid);
    }

    #[test]
    fn duplicates_and_blank_lines_are_collapsed() {
        let checks = validate_urls(
            "https://youtu.be/a\n\n   \nhttps://youtu.be/a\nhttps://youtu.be/b".into(),
        );
        assert_eq!(checks.len(), 2);
    }

    #[test]
    fn prose_around_a_link_is_tolerated() {
        let checks = validate_urls("看看这个 https://youtu.be/aqz-KE-bpKQ 很棒".into());
        assert_eq!(checks.len(), 1);
        assert!(checks[0].valid);
    }

    #[test]
    fn non_http_schemes_are_rejected() {
        let checks = validate_urls("ftp://example.com/video.mp4".into());
        assert!(!checks[0].valid);
        assert!(checks[0].reason.as_deref().unwrap().contains("http"));
    }

    #[test]
    fn nonsense_is_reported_as_invalid() {
        let checks = validate_urls("not a url at all".into());
        assert_eq!(checks.len(), 1);
        assert!(!checks[0].valid);
    }
}
