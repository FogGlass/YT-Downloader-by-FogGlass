//! Library models: download history and favourites.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HistoryStatus {
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub task_id: String,
    pub url: String,
    pub title: String,
    pub thumbnail: Option<String>,
    pub uploader: Option<String>,
    pub duration: Option<f64>,
    pub file_path: Option<String>,
    pub directory: Option<String>,
    pub size_bytes: u64,
    pub container: Option<String>,
    pub status: HistoryStatus,
    pub selection_label: Option<String>,
    pub error: Option<String>,
    pub finished_at: String,
    pub subtitle_paths: Vec<String>,
    pub merged_from: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteEntry {
    pub id: String,
    pub url: String,
    pub title: String,
    pub thumbnail: Option<String>,
    pub uploader: Option<String>,
    pub duration: Option<f64>,
    pub created_at: String,
    pub note: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_entries_round_trip() {
        let entry = HistoryEntry {
            id: "h1".into(),
            task_id: "t1".into(),
            url: "https://youtu.be/x".into(),
            title: "Test".into(),
            thumbnail: None,
            uploader: Some("Someone".into()),
            duration: Some(12.5),
            file_path: Some(r"E:\out\a.mkv".into()),
            directory: Some(r"E:\out".into()),
            size_bytes: 1024,
            container: Some("mkv".into()),
            status: HistoryStatus::Completed,
            selection_label: Some("1080p · AV1".into()),
            error: None,
            finished_at: "2026-09-13 12:00:00".into(),
            subtitle_paths: vec![],
            merged_from: vec!["399".into(), "251".into()],
        };
        let text = serde_json::to_string(&entry).unwrap();
        let restored: HistoryEntry = serde_json::from_str(&text).unwrap();
        assert_eq!(restored.title, "Test");
        assert_eq!(restored.size_bytes, 1024);
        assert_eq!(restored.status, HistoryStatus::Completed);
    }
}
