//! Turning yt-dlp failures into something a person can act on.
//!
//! The UI shows `summary` by default and the untouched stderr in Expert Mode, so the
//! mapping is always additive: raw output is never discarded here.

use crate::models::task::TaskError;
use crate::process::ProcessOutcome;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    Network,
    Auth,
    /// The browser's cookie store could not be read *or* decrypted. This is a distinct
    /// failure from being logged out: reporting it as "needs sign-in" sends the user
    /// looking for a password problem that does not exist.
    Cookie,
    Unavailable,
    Format,
    Runtime,
    Drm,
    Unsupported,
    DiskSpace,
    Cancelled,
    Unknown,
}

impl FailureKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Network => "network",
            Self::Auth => "auth",
            Self::Cookie => "cookie",
            Self::Unavailable => "unavailable",
            Self::Format => "format",
            Self::Runtime => "runtime",
            Self::Drm => "drm",
            Self::Unsupported => "unsupported",
            Self::DiskSpace => "diskSpace",
            Self::Cancelled => "cancelled",
            Self::Unknown => "unknown",
        }
    }
}

pub struct Rule {
    kind: FailureKind,
    needles: &'static [&'static str],
    summary: &'static str,
    hint: &'static str,
}

/// Classified failure: what happened, and what the user can do about it.
#[derive(Debug, Clone)]
pub struct Classification {
    pub kind: FailureKind,
    pub summary: String,
    pub hint: Option<String>,
}

const RULES: &[Rule] = &[
    // ---- Cookie store problems -------------------------------------------
    //
    // These MUST be matched before the authentication rule: a browser cookie store
    // that cannot be decrypted produces text that looks login-related, and yt-dlp
    // itself reports "Could not copy Chrome cookie database" for Edge as well (both
    // are Chromium). Getting this wrong is what turned a decryption problem into a
    // bogus "sign in to confirm you're not a bot" message.
    Rule {
        kind: FailureKind::Cookie,
        needles: &[
            "failed to decrypt with dpapi",
            "dpapi",
            "unable to decrypt",
            "could not decrypt",
            "app-bound encryption",
            "app bound encryption",
            "decryption failed",
        ],
        summary: "无法解密 Edge 的 Cookie 数据库",
        hint: "Edge 127 及以后使用「应用绑定加密」保护 Cookie，yt-dlp 无法直接解密。\
               请在「设置 → Cookies」改用导出的 cookies.txt，或选择「不使用 Cookie」继续下载。",
    },
    Rule {
        kind: FailureKind::Cookie,
        needles: &[
            "could not copy",
            "cookie database",
            "cookies database",
            "unable to open database",
            "database is locked",
            "being used by another process",
            "the process cannot access the file",
        ],
        summary: "无法读取 Edge 的 Cookie 数据库",
        hint: "数据库可能正被 Edge 占用。请完全退出 Edge（包括后台进程与托盘图标）后重试，\
               或改用 cookies.txt，或选择「不使用 Cookie」继续。",
    },
    Rule {
        kind: FailureKind::Cookie,
        needles: &[
            "permission denied",
            "errno 13",
            "access is denied",
            "cannot read cookies",
            "failed to read cookies",
        ],
        summary: "没有读取浏览器 Cookie 的权限",
        hint: "请以当前用户身份运行本程序，并确认浏览器配置文件未被其它账户占用；\
               也可以改用 cookies.txt 或选择「不使用 Cookie」。",
    },
    // ---- Authentication ---------------------------------------------------
    Rule {
        kind: FailureKind::Auth,
        needles: &[
            "sign in to confirm you're not a bot",
            "sign in to confirm your age",
            "this video may be inappropriate for some users",
            "login required",
            "cookies are no longer valid",
            "use --cookies",
        ],
        summary: "需要登录或通过人机校验",
        hint: "请在「设置 → Cookies」中启用浏览器 Cookies，或指定 cookies.txt 后重试。",
    },
    Rule {
        kind: FailureKind::Drm,
        needles: &["drm protected", "drm", "requires a premium", "this video is only available to"],
        summary: "该内容受 DRM 或会员权限保护",
        hint: "本应用不会绕过 DRM、付费墙或任何访问控制。",
    },
    Rule {
        kind: FailureKind::Unavailable,
        needles: &[
            "video unavailable",
            "this video is not available",
            "private video",
            "has been removed",
            "removed by the uploader",
            "account has been terminated",
            "no video formats found",
        ],
        summary: "视频不可用",
        hint: "视频可能已被删除、设为私享或存在地区限制。",
    },
    Rule {
        kind: FailureKind::Network,
        needles: &[
            "getaddrinfo failed",
            "name or service not known",
            "temporary failure in name resolution",
            "failed to resolve",
            "connection reset",
            "connection refused",
            "timed out",
            "read timed out",
            "unable to download webpage",
            "network is unreachable",
            "ssl",
            "certificate verify failed",
            "proxyerror",
        ],
        summary: "网络连接失败",
        hint: "请检查网络、代理设置，或稍后重试；也可以降低并发分片数量。",
    },
    Rule {
        kind: FailureKind::Format,
        needles: &[
            "requested format is not available",
            "no suitable format",
            "requested format not available",
        ],
        summary: "所选格式已不可用",
        hint: "请重新解析并选择另一个格式后再下载。",
    },
    Rule {
        kind: FailureKind::Runtime,
        needles: &[
            "ffmpeg not found",
            "ffprobe not found",
            "postprocessing: ffmpeg",
            "you have requested merging of multiple formats",
            "is not recognized as an internal or external command",
            "no such file or directory",
            "python",
        ],
        summary: "运行库不可用",
        hint: "请确认运行库目录中存在 yt-dlp、ffmpeg 与 ffprobe（设置 → 高级）。",
    },
    Rule {
        kind: FailureKind::DiskSpace,
        needles: &["no space left", "not enough space", "disk full"],
        summary: "磁盘空间不足",
        hint: "请清理目标磁盘或更换下载目录。",
    },
    Rule {
        kind: FailureKind::Unsupported,
        needles: &["unsupported url", "is not a valid url"],
        summary: "链接不受支持",
        hint: "请确认这是一个 yt-dlp 支持的视频页面链接。",
    },
];

/// Classify a stderr blob.
pub fn classify(stderr: &str) -> Classification {
    let haystack = stderr.to_ascii_lowercase();
    for rule in RULES {
        if rule.needles.iter().any(|needle| haystack.contains(needle)) {
            return Classification {
                kind: rule.kind,
                summary: rule.summary.to_string(),
                hint: Some(rule.hint.to_string()),
            };
        }
    }
    Classification {
        kind: FailureKind::Unknown,
        summary: "下载失败".to_string(),
        hint: None,
    }
}

/// The generic hint that belongs to a failure kind.
pub fn hint_for(kind: FailureKind) -> Option<String> {
    RULES
        .iter()
        .find(|rule| rule.kind == kind)
        .map(|rule| rule.hint.to_string())
}

/// The last genuinely informative line of yt-dlp's stderr.
pub fn salient_line(stderr: &[String]) -> Option<String> {
    stderr
        .iter()
        .rev()
        .map(|line| line.trim())
        .find(|line| {
            !line.is_empty()
                && !line.starts_with("[download]")
                && !line.starts_with("[info]")
                && !line.starts_with("WARNING: Retrying")
        })
        .map(|line| line.trim_start_matches("ERROR: ").to_string())
}

/// Build the user-facing error for a failed download process.
pub fn from_outcome(outcome: &ProcessOutcome) -> TaskError {
    if outcome.cancelled {
        return TaskError {
            summary: "已取消".into(),
            detail: None,
            hint: None,
            kind: FailureKind::Cancelled.as_str().into(),
            exit_code: outcome.code,
            command: None,
        };
    }

    let stderr = outcome.stderr_text();
    let classification = classify(&stderr);
    let detail = salient_line(&outcome.stderr_tail).or_else(|| {
        outcome
            .stderr_tail
            .last()
            .map(|line| line.trim().to_string())
    });

    let mut summary = classification.summary;
    if outcome.timed_out {
        summary = "操作超时".into();
    }

    TaskError {
        summary,
        detail,
        hint: classification.hint,
        kind: classification.kind.as_str().into(),
        exit_code: outcome.code,
        command: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outcome(stderr: &[&str], code: Option<i32>) -> ProcessOutcome {
        ProcessOutcome {
            code,
            cancelled: false,
            timed_out: false,
            stdout_tail: Vec::new(),
            stderr_tail: stderr.iter().map(|line| line.to_string()).collect(),
        }
    }

    #[test]
    fn bot_check_maps_to_authentication() {
        let error = from_outcome(&outcome(
            &["ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies"],
            Some(1),
        ));
        assert_eq!(error.kind, "auth");
        assert_eq!(error.summary, "需要登录或通过人机校验");
        assert!(error.detail.unwrap().contains("Sign in"));
    }

    #[test]
    fn dpapi_decryption_failure_is_reported_as_a_cookie_problem() {
        // The real yt-dlp output when Edge's cookies use app-bound encryption.
        let error = from_outcome(&outcome(
            &[
                "Extracting cookies from edge",
                "ERROR: Failed to decrypt with DPAPI. See  https://github.com/yt-dlp/yt-dlp/issues/10927  for more info",
            ],
            Some(1),
        ));
        assert_eq!(error.kind, "cookie");
        assert_eq!(error.summary, "无法解密 Edge 的 Cookie 数据库");
        assert!(
            error.hint.unwrap().contains("cookies.txt"),
            "the hint must offer a way forward"
        );
    }

    #[test]
    fn a_locked_cookie_database_is_not_reported_as_an_expired_login() {
        // This exact string is what yt-dlp prints for Edge as well, because both are
        // Chromium browsers. It used to be classified as "needs sign-in".
        let error = from_outcome(&outcome(
            &["ERROR: Could not copy Chrome cookie database. See https://github.com/yt-dlp/yt-dlp/issues/7271 for more info"],
            Some(1),
        ));
        assert_eq!(error.kind, "cookie");
        assert_ne!(error.kind, "auth");
        assert!(error.summary.contains("无法读取"));
        assert!(error.hint.as_deref().unwrap_or("").contains("退出 Edge"));
    }

    #[test]
    fn an_actually_expired_login_still_maps_to_authentication() {
        let error = from_outcome(&outcome(
            &["ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users."],
            Some(1),
        ));
        assert_eq!(error.kind, "auth");
    }

    #[test]
    fn network_failures_are_recognised() {
        let error = from_outcome(&outcome(
            &["ERROR: unable to download webpage: <urlopen error [Errno 11001] getaddrinfo failed>"],
            Some(1),
        ));
        assert_eq!(error.kind, "network");
    }

    #[test]
    fn ffmpeg_problems_are_attributed_to_the_runtime() {
        let error = from_outcome(&outcome(
            &["ERROR: Postprocessing: ffmpeg not found. Please install or provide the path"],
            Some(1),
        ));
        assert_eq!(error.kind, "runtime");
    }

    #[test]
    fn drm_is_refused_with_a_clear_reason() {
        let error = from_outcome(&outcome(
            &["ERROR: [youtube] xyz: This video is DRM protected"],
            Some(1),
        ));
        assert_eq!(error.kind, "drm");
        assert!(hint_for(FailureKind::Drm).unwrap().contains("DRM"));
    }

    #[test]
    fn cancellations_are_not_reported_as_failures() {
        let mut failed = outcome(&["ERROR: interrupted"], Some(1));
        failed.cancelled = true;
        let error = from_outcome(&failed);
        assert_eq!(error.kind, "cancelled");
        assert_eq!(error.summary, "已取消");
    }

    #[test]
    fn noisy_progress_lines_are_skipped_when_choosing_the_detail() {
        let error = from_outcome(&outcome(
            &[
                "[download] Destination: out.webm",
                "[download]  50.0% of 1.00MiB",
                "ERROR: unable to download video data: HTTP Error 403: Forbidden",
            ],
            Some(1),
        ));
        assert_eq!(
            error.detail.unwrap(),
            "unable to download video data: HTTP Error 403: Forbidden"
        );
    }

    #[test]
    fn timeouts_are_labelled() {
        let mut failed = outcome(&["some output"], None);
        failed.timed_out = true;
        let error = from_outcome(&failed);
        assert_eq!(error.summary, "操作超时");
    }

    #[test]
    fn unknown_failures_still_carry_the_exit_code() {
        let error = from_outcome(&outcome(&["ERROR: something bizarre happened"], Some(7)));
        assert_eq!(error.kind, "unknown");
        assert_eq!(error.exit_code, Some(7));
    }
}
