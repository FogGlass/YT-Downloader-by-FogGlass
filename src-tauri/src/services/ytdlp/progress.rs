//! Progress line parsing.
//!
//! yt-dlp is asked for machine readable progress through `--progress-template` with a
//! private prefix, so the parser never has to deal with human-formatted output.

use serde::{Deserialize, Serialize};

pub const PROGRESS_PREFIX: &str = "YTPROG|";
pub const POSTPROCESS_PREFIX: &str = "YTPOST|";
pub const DESTINATION_PREFIX: &str = "YTFILE|";

/// The template handed to yt-dlp. Field order must match [`ProgressUpdate::parse`].
pub const PROGRESS_TEMPLATE: &str = "download:YTPROG|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.fragment_index)s|%(progress.fragment_count)s";

/// Post-processing events (muxing, embedding), used for the "合并中" stage.
pub const POSTPROCESS_TEMPLATE: &str =
    "postprocess:YTPOST|%(progress.status)s|%(progress.postprocessor)s";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressUpdate {
    pub status: String,
    pub downloaded_bytes: f64,
    pub total_bytes: Option<f64>,
    pub speed: Option<f64>,
    pub eta: Option<f64>,
    pub fragment_index: Option<u64>,
    pub fragment_count: Option<u64>,
}

impl ProgressUpdate {
    pub fn parse(line: &str) -> Option<Self> {
        let payload = line.strip_prefix(PROGRESS_PREFIX)?;
        let fields: Vec<&str> = payload.split('|').collect();
        if fields.len() < 8 {
            return None;
        }

        Some(Self {
            status: fields[0].trim().to_string(),
            downloaded_bytes: number(fields[1]).unwrap_or(0.0),
            total_bytes: number(fields[2]).or_else(|| number(fields[3])),
            speed: number(fields[4]),
            eta: number(fields[5]),
            fragment_index: number(fields[6]).map(|value| value as u64),
            fragment_count: number(fields[7]).map(|value| value as u64),
        })
    }

    /// Best-known completion ratio for this stream, if a total is known.
    pub fn ratio(&self) -> Option<f64> {
        if let Some(total) = self.total_bytes.filter(|value| *value > 0.0) {
            return Some((self.downloaded_bytes / total).clamp(0.0, 1.0));
        }
        match (self.fragment_index, self.fragment_count) {
            (Some(index), Some(count)) if count > 0 => {
                Some((index as f64 / count as f64).clamp(0.0, 1.0))
            }
            _ => None,
        }
    }

    pub fn is_finished(&self) -> bool {
        matches!(self.status.as_str(), "finished" | "finished_unknown")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostProcessUpdate {
    pub status: String,
    pub postprocessor: String,
}

impl PostProcessUpdate {
    pub fn parse(line: &str) -> Option<Self> {
        let payload = line.strip_prefix(POSTPROCESS_PREFIX)?;
        let (status, postprocessor) = payload.split_once('|')?;
        Some(Self {
            status: status.trim().to_string(),
            postprocessor: postprocessor.trim().to_string(),
        })
    }
}

/// `NaN`, `NA` and empty fields all mean "unknown" in yt-dlp output.
fn number(raw: &str) -> Option<f64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("na") || trimmed.eq_ignore_ascii_case("none") {
        return None;
    }
    match trimmed.parse::<f64>() {
        Ok(value) if value.is_finite() => Some(value),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_lines_are_parsed() {
        let line = "YTPROG|downloading|1048576|10485760|NA|524288.0|18|NA|NA";
        let update = ProgressUpdate::parse(line).unwrap();
        assert_eq!(update.status, "downloading");
        assert_eq!(update.downloaded_bytes, 1048576.0);
        assert_eq!(update.total_bytes, Some(10485760.0));
        assert_eq!(update.speed, Some(524288.0));
        assert_eq!(update.eta, Some(18.0));
        assert_eq!(update.ratio(), Some(0.1));
    }

    #[test]
    fn fragment_progress_is_used_when_bytes_are_unknown() {
        let line = "YTPROG|downloading|NA|NA|NA|NA|NA|3|12";
        let update = ProgressUpdate::parse(line).unwrap();
        assert_eq!(update.total_bytes, None);
        assert_eq!(update.ratio(), Some(0.25));
    }

    #[test]
    fn estimated_totals_are_accepted() {
        let line = "YTPROG|downloading|500|NA|1000|NA|NA|NA|NA";
        let update = ProgressUpdate::parse(line).unwrap();
        assert_eq!(update.total_bytes, Some(1000.0));
        assert_eq!(update.ratio(), Some(0.5));
    }

    #[test]
    fn unrelated_lines_are_ignored() {
        assert!(ProgressUpdate::parse("[download] 12.3% of 1.00MiB").is_none());
        assert!(ProgressUpdate::parse("YTPROG|only|two").is_none());
    }

    #[test]
    fn postprocessor_updates_are_parsed() {
        let update = PostProcessUpdate::parse("YTPOST|started|Merger").unwrap();
        assert_eq!(update.status, "started");
        assert_eq!(update.postprocessor, "Merger");
    }

    #[test]
    fn finished_status_is_recognised() {
        let update = ProgressUpdate::parse("YTPROG|finished|10|10|NA|NA|NA|NA|NA").unwrap();
        assert!(update.is_finished());
    }

    #[test]
    fn zero_totals_do_not_produce_infinite_ratios() {
        let update = ProgressUpdate::parse("YTPROG|downloading|5|0|NA|NA|NA|NA|NA").unwrap();
        assert_eq!(update.ratio(), None);
    }
}
