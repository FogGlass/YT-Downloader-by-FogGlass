//! Secret handling.
//!
//! Cookie files, browser profiles, credentials and authenticated proxies must never
//! reach a log file, a toast, an error report or the command preview shown in Expert
//! Mode. Every argument list passes through here before it is rendered or journalled.

/// Flags whose *value* is sensitive and must never be echoed.
const SECRET_FLAGS: [&str; 14] = [
    "--cookies",
    "--cookies-from-browser",
    "--username",
    "-u",
    "--password",
    "-p",
    "--video-password",
    "--ap-username",
    "--ap-password",
    "--netrc-location",
    "--client-certificate",
    "--client-certificate-key",
    "--add-header",
    "--referer",
];

/// True when the argument itself names a secret-bearing flag.
pub fn is_secret_flag(argument: &str) -> bool {
    let bare = argument.split('=').next().unwrap_or(argument);
    SECRET_FLAGS
        .iter()
        .any(|flag| flag.eq_ignore_ascii_case(bare))
}

/// Mask credentials embedded in a URL (`http://user:pass@host`).
pub fn redact_url_credentials(argument: &str) -> String {
    let Some(scheme_end) = argument.find("://") else {
        return argument.to_string();
    };
    let authority_start = scheme_end + 3;
    let rest = &argument[authority_start..];
    let authority_end = rest
        .find(['/', '?', '#'])
        .unwrap_or(rest.len());
    let authority = &rest[..authority_end];

    let Some(at) = authority.rfind('@') else {
        return argument.to_string();
    };

    // Only the password is masked; the user, host and port stay readable so the
    // preview still identifies which proxy is in use.
    let userinfo = &authority[..at];
    let user = userinfo.split(':').next().unwrap_or("");
    let host = &authority[at + 1..];
    let masked = format!("{user}:***@{host}");
    let mut result = String::with_capacity(argument.len());
    result.push_str(&argument[..authority_start]);
    result.push_str(&masked);
    result.push_str(&rest[authority_end..]);
    result
}

/// Redact a single argument in place.
pub fn redact_value(argument: &str) -> String {
    if let Some(separator) = argument.find("://") {
        let _ = separator;
        return redact_url_credentials(argument);
    }
    if let Some((flag, _value)) = argument.split_once('=') {
        if is_secret_flag(flag) {
            return format!("{flag}=***");
        }
    }
    argument.to_string()
}

/// Cookie/credential-bearing arguments are dropped entirely from diagnostics.
pub fn sanitise_args_for_log(args: &[String]) -> Vec<String> {
    let mut safe = Vec::with_capacity(args.len());
    let mut skip_next = false;

    for argument in args {
        if skip_next {
            skip_next = false;
            safe.push("***".to_string());
            continue;
        }
        if is_secret_flag(argument) {
            safe.push(argument.clone());
            if !argument.contains('=') {
                skip_next = true;
            }
            continue;
        }
        safe.push(redact_value(argument));
    }

    safe
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_flags_are_detected() {
        assert!(is_secret_flag("--cookies"));
        assert!(is_secret_flag("--cookies=E:\\a.txt"));
        assert!(is_secret_flag("--cookies-from-browser"));
        assert!(!is_secret_flag("--output"));
        assert!(!is_secret_flag("--format"));
    }

    #[test]
    fn proxy_credentials_are_masked() {
        let masked = redact_url_credentials("http://alice:hunter2@127.0.0.1:7890");
        assert_eq!(masked, "http://alice:***@127.0.0.1:7890");
        // SOCKS proxies are masked the same way.
        let masked = redact_url_credentials("socks5://bob:secret@10.0.0.1:1080");
        assert!(masked.contains("***"));
        assert!(!masked.contains("secret"));
    }

    #[test]
    fn urls_without_credentials_survive() {
        assert_eq!(
            redact_url_credentials("http://127.0.0.1:7890"),
            "http://127.0.0.1:7890"
        );
        assert_eq!(
            redact_url_credentials("https://www.youtube.com/watch?v=abc"),
            "https://www.youtube.com/watch?v=abc"
        );
    }

    #[test]
    fn full_argument_lists_strip_cookie_paths() {
        let args = vec![
            "--cookies-from-browser".to_string(),
            "chrome:Default".to_string(),
            "--format".to_string(),
            "137+251".to_string(),
        ];
        let safe = sanitise_args_for_log(&args);
        assert_eq!(safe[1], "***");
        assert_eq!(safe[2], "--format");
        assert_eq!(safe[3], "137+251");
    }
}
