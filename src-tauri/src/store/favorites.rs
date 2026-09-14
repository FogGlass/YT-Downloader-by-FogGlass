//! Saved links the user wants to come back to.

use std::sync::RwLock;

use crate::core::error::AppResult;
use crate::core::fs_util::{read_json, write_json};
use crate::core::paths::DataRoots;
use crate::models::library::FavoriteEntry;

pub struct FavoritesStore {
    roots: DataRoots,
    entries: RwLock<Vec<FavoriteEntry>>,
}

impl FavoritesStore {
    pub fn load(roots: DataRoots) -> AppResult<Self> {
        let loaded: Vec<FavoriteEntry> = read_json(&roots.favorites_file())?.unwrap_or_default();
        Ok(Self {
            roots,
            entries: RwLock::new(loaded),
        })
    }

    pub fn list(&self) -> Vec<FavoriteEntry> {
        let guard = match self.entries.read() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let mut entries = guard.clone();
        entries.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        entries
    }

    /// Add or update a favourite, keyed by URL so starring twice is idempotent.
    pub fn upsert(&self, entry: FavoriteEntry) -> AppResult<Vec<FavoriteEntry>> {
        {
            let mut guard = match self.entries.write() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            match guard.iter_mut().find(|existing| existing.url == entry.url) {
                Some(existing) => {
                    existing.title = entry.title;
                    existing.thumbnail = entry.thumbnail;
                    existing.uploader = entry.uploader;
                    existing.duration = entry.duration;
                    if entry.note.is_some() {
                        existing.note = entry.note;
                    }
                }
                None => guard.push(entry),
            }
        }
        self.persist()?;
        Ok(self.list())
    }

    pub fn remove(&self, id: &str) -> AppResult<Vec<FavoriteEntry>> {
        {
            let mut guard = match self.entries.write() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            guard.retain(|entry| entry.id != id);
        }
        self.persist()?;
        Ok(self.list())
    }

    pub fn contains(&self, url: &str) -> bool {
        self.entries
            .read()
            .map(|guard| guard.iter().any(|entry| entry.url == url))
            .unwrap_or(false)
    }

    fn persist(&self) -> AppResult<()> {
        write_json(&self.roots.favorites_file(), &self.list())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::paths::DataRoots;

    fn roots(name: &str) -> DataRoots {
        let root = std::env::temp_dir().join(format!("ytd-favorites-{name}"));
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

    fn favorite(id: &str, url: &str) -> FavoriteEntry {
        FavoriteEntry {
            id: id.into(),
            url: url.into(),
            title: format!("Fav {id}"),
            thumbnail: None,
            uploader: None,
            duration: None,
            created_at: "2026-01-01 10:00:00".into(),
            note: None,
        }
    }

    #[test]
    fn starring_the_same_url_twice_updates_in_place() {
        let roots = roots("upsert");
        roots.ensure().unwrap();
        let store = FavoritesStore::load(roots).unwrap();
        store.upsert(favorite("1", "https://youtu.be/x")).unwrap();
        let mut again = favorite("2", "https://youtu.be/x");
        again.title = "Renamed".into();
        let list = store.upsert(again).unwrap();

        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title, "Renamed");
    }

    #[test]
    fn removal_persists() {
        let roots = roots("remove");
        roots.ensure().unwrap();
        let store = FavoritesStore::load(roots.clone()).unwrap();
        store.upsert(favorite("1", "https://youtu.be/x")).unwrap();
        let list = store.remove("1").unwrap();
        assert!(list.is_empty());
        assert!(FavoritesStore::load(roots).unwrap().list().is_empty());
    }

    #[test]
    fn containment_can_be_queried_for_the_star_state() {
        let roots = roots("contains");
        roots.ensure().unwrap();
        let store = FavoritesStore::load(roots).unwrap();
        store.upsert(favorite("1", "https://youtu.be/x")).unwrap();
        assert!(store.contains("https://youtu.be/x"));
        assert!(!store.contains("https://youtu.be/y"));
    }
}
