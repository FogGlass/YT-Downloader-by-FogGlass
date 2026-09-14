//! Download history.

use std::sync::RwLock;

use crate::core::error::AppResult;
use crate::core::fs_util::{read_json, write_json};
use crate::core::paths::DataRoots;
use crate::models::library::{HistoryEntry, HistoryStatus};

/// Keep the library bounded so the JSON document stays fast to load.
const MAX_ENTRIES: usize = 2000;

pub struct HistoryStore {
    roots: DataRoots,
    entries: RwLock<Vec<HistoryEntry>>,
}

impl HistoryStore {
    pub fn load(roots: DataRoots) -> AppResult<Self> {
        let loaded: Vec<HistoryEntry> = read_json(&roots.history_file())?.unwrap_or_default();
        Ok(Self {
            roots,
            entries: RwLock::new(loaded),
        })
    }

    pub fn list(&self, limit: Option<usize>) -> Vec<HistoryEntry> {
        let guard = match self.entries.read() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let mut entries = guard.clone();
        // Newest first.
        entries.sort_by(|left, right| right.finished_at.cmp(&left.finished_at));
        match limit {
            Some(limit) => entries.into_iter().take(limit).collect(),
            None => entries,
        }
    }

    pub fn get(&self, id: &str) -> Option<HistoryEntry> {
        self.entries
            .read()
            .ok()
            .and_then(|guard| guard.iter().find(|entry| entry.id == id).cloned())
    }

    pub fn add(&self, entry: HistoryEntry) -> AppResult<()> {
        {
            let mut guard = match self.entries.write() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            // Re-downloading the same task replaces its earlier record.
            guard.retain(|existing| existing.task_id != entry.task_id);
            guard.push(entry);
            if guard.len() > MAX_ENTRIES {
                let excess = guard.len() - MAX_ENTRIES;
                guard.drain(0..excess);
            }
        }
        self.persist()
    }

    pub fn remove(&self, id: &str) -> AppResult<bool> {
        let removed = {
            let mut guard = match self.entries.write() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            let before = guard.len();
            guard.retain(|entry| entry.id != id);
            guard.len() != before
        };
        if removed {
            self.persist()?;
        }
        Ok(removed)
    }

    pub fn clear(&self, only_failed: bool) -> AppResult<usize> {
        let removed = {
            let mut guard = match self.entries.write() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            let before = guard.len();
            if only_failed {
                guard.retain(|entry| entry.status == HistoryStatus::Completed);
            } else {
                guard.clear();
            }
            before - guard.len()
        };
        self.persist()?;
        Ok(removed)
    }

    pub fn total_bytes(&self) -> u64 {
        self.entries
            .read()
            .map(|guard| guard.iter().map(|entry| entry.size_bytes).sum())
            .unwrap_or(0)
    }

    fn persist(&self) -> AppResult<()> {
        let snapshot = self.list(None);
        write_json(&self.roots.history_file(), &snapshot)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::paths::DataRoots;

    fn roots(name: &str) -> DataRoots {
        let root = std::env::temp_dir().join(format!("ytd-history-{name}"));
        let _ = std::fs::remove_dir_all(&root);
        DataRoots {
            config: root.join("config"),
            history: root.join("history"),
            favorites: root.join("favorites"),
            logs: root.join("logs"),
            cache: root.join("cache"),
            temp: root.join("temp"),
            downloads: root.join("downloads"),
            root,
        }
    }

    fn entry(id: &str, task: &str, at: &str) -> HistoryEntry {
        HistoryEntry {
            id: id.into(),
            task_id: task.into(),
            url: "https://youtu.be/x".into(),
            title: format!("Clip {id}"),
            thumbnail: None,
            uploader: None,
            duration: Some(10.0),
            file_path: Some(r"E:\out\a.mkv".into()),
            directory: Some(r"E:\out".into()),
            size_bytes: 100,
            container: Some("mkv".into()),
            status: HistoryStatus::Completed,
            selection_label: None,
            error: None,
            finished_at: at.into(),
            subtitle_paths: vec![],
            merged_from: vec![],
        }
    }

    #[test]
    fn entries_are_listed_newest_first() {
        let roots = roots("order");
        roots.ensure().unwrap();
        let store = HistoryStore::load(roots).unwrap();
        store.add(entry("1", "t1", "2026-01-01 10:00:00")).unwrap();
        store.add(entry("2", "t2", "2026-02-01 10:00:00")).unwrap();

        let list = store.list(None);
        assert_eq!(list[0].id, "2");
        assert_eq!(list[1].id, "1");
    }

    #[test]
    fn the_same_task_replaces_its_record() {
        let roots = roots("replace");
        roots.ensure().unwrap();
        let store = HistoryStore::load(roots).unwrap();
        store.add(entry("1", "task-a", "2026-01-01 10:00:00")).unwrap();
        store.add(entry("2", "task-a", "2026-01-01 11:00:00")).unwrap();
        assert_eq!(store.list(None).len(), 1);
        assert_eq!(store.list(None)[0].id, "2");
    }

    #[test]
    fn removal_and_clearing_work_and_persist() {
        let roots = roots("remove");
        roots.ensure().unwrap();
        let store = HistoryStore::load(roots.clone()).unwrap();
        store.add(entry("1", "t1", "2026-01-01 10:00:00")).unwrap();
        store.add(entry("2", "t2", "2026-01-02 10:00:00")).unwrap();

        assert!(store.remove("1").unwrap());
        assert_eq!(store.list(None).len(), 1);
        assert_eq!(store.clear(false).unwrap(), 1);

        let reopened = HistoryStore::load(roots).unwrap();
        assert!(reopened.list(None).is_empty());
    }

    #[test]
    fn only_failed_clearing_keeps_successful_entries() {
        let roots = roots("clear-failed");
        roots.ensure().unwrap();
        let store = HistoryStore::load(roots).unwrap();
        store.add(entry("1", "t1", "2026-01-01 10:00:00")).unwrap();
        let mut failed = entry("2", "t2", "2026-01-02 10:00:00");
        failed.status = HistoryStatus::Failed;
        store.add(failed).unwrap();

        assert_eq!(store.clear(true).unwrap(), 1);
        let remaining = store.list(None);
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].status, HistoryStatus::Completed);
    }

    #[test]
    fn totals_are_accumulated() {
        let roots = roots("total");
        roots.ensure().unwrap();
        let store = HistoryStore::load(roots).unwrap();
        store.add(entry("1", "t1", "2026-01-01 10:00:00")).unwrap();
        store.add(entry("2", "t2", "2026-01-02 10:00:00")).unwrap();
        assert_eq!(store.total_bytes(), 200);
    }
}
