//! The single source of truth for user settings.

use std::sync::RwLock;

use crate::core::error::AppResult;
use crate::core::fs_util::{read_json, write_json};
use crate::core::paths::DataRoots;
use crate::models::settings::AppSettings;
use crate::log_info;

pub struct SettingsStore {
    roots: DataRoots,
    current: RwLock<AppSettings>,
}

impl SettingsStore {
    /// Load settings from disk, creating defaults on first run.
    pub fn load(roots: DataRoots) -> AppResult<Self> {
        let file = roots.settings_file();
        let loaded: Option<AppSettings> = read_json(&file).unwrap_or_else(|error| {
            crate::log_warn!("settings", "settings file unreadable ({error}), using defaults");
            None
        });

        let settings = loaded
            .unwrap_or_default()
            .with_defaults(&roots);

        let store = Self {
            roots,
            current: RwLock::new(settings.clone()),
        };

        // Persist immediately so the file exists and can be edited by hand.
        store.save_to_disk(&settings)?;
        log_info!(
            "settings",
            "settings ready at {} (theme={:?}, concurrency={})",
            file.display(),
            settings.appearance.theme,
            settings.downloads.concurrency
        );
        Ok(store)
    }

    pub fn snapshot(&self) -> AppSettings {
        self.current
            .read()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    /// Replace the whole settings document and persist it.
    pub fn replace(&self, settings: AppSettings) -> AppResult<AppSettings> {
        let merged = settings.with_defaults(&self.roots);
        {
            let mut guard = self
                .current
                .write()
                .map_err(|_| crate::core::AppError::message("设置状态不可用"))?;
            *guard = merged.clone();
        }
        self.save_to_disk(&merged)?;
        Ok(merged)
    }

    /// Apply a partial patch on top of the current document.
    pub fn patch(&self, patch: SettingsPatch) -> AppResult<AppSettings> {
        let mut current = self.snapshot();
        patch.apply(&mut current);
        self.replace(current)
    }

    fn save_to_disk(&self, settings: &AppSettings) -> AppResult<()> {
        write_json(&self.roots.settings_file(), settings)
    }

    pub fn roots(&self) -> &DataRoots {
        &self.roots
    }
}

/// A partial update: only the sections present are replaced.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsPatch {
    pub general: Option<crate::models::settings::GeneralSettings>,
    pub downloads: Option<crate::models::settings::DownloadSettings>,
    pub youtube: Option<crate::models::settings::YoutubeSettings>,
    pub cookies: Option<crate::models::settings::CookieSettings>,
    pub network: Option<crate::models::settings::NetworkSettings>,
    pub appearance: Option<crate::models::settings::AppearanceSettings>,
    pub advanced: Option<crate::models::settings::AdvancedSettings>,
    pub limits: Option<crate::models::settings::LimitSettings>,
}

impl SettingsPatch {
    fn apply(self, target: &mut AppSettings) {
        if let Some(value) = self.general {
            target.general = value;
        }
        if let Some(value) = self.downloads {
            target.downloads = value;
        }
        if let Some(value) = self.youtube {
            target.youtube = value;
        }
        if let Some(value) = self.cookies {
            target.cookies = value;
        }
        if let Some(value) = self.network {
            target.network = value;
        }
        if let Some(value) = self.appearance {
            target.appearance = value;
        }
        if let Some(value) = self.advanced {
            target.advanced = value;
        }
        if let Some(value) = self.limits {
            target.limits = value;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::paths::DataRoots;

    fn temp_roots(name: &str) -> DataRoots {
        let root = std::env::temp_dir().join(format!("ytd-settings-{name}"));
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

    #[test]
    fn first_run_creates_a_default_document() {
        let roots = temp_roots("default");
        roots.ensure().unwrap();
        let store = SettingsStore::load(roots.clone()).unwrap();
        assert!(roots.settings_file().is_file());
        assert_eq!(store.snapshot().downloads.concurrency, 2);
    }

    #[test]
    fn patches_only_touch_the_named_section() {
        let roots = temp_roots("patch");
        roots.ensure().unwrap();
        let store = SettingsStore::load(roots).unwrap();

        let mut downloads = store.snapshot().downloads;
        downloads.concurrency = 4;
        let updated = store
            .patch(SettingsPatch {
                downloads: Some(downloads),
                ..Default::default()
            })
            .unwrap();

        assert_eq!(updated.downloads.concurrency, 4);
        // Untouched sections keep their values.
        assert_eq!(updated.network.retries, 10);
    }

    #[test]
    fn settings_survive_a_reload() {
        let roots = temp_roots("reload");
        roots.ensure().unwrap();
        {
            let store = SettingsStore::load(roots.clone()).unwrap();
            let mut appearance = store.snapshot().appearance;
            appearance.theme = crate::models::settings::ThemeMode::Light;
            store
                .patch(SettingsPatch {
                    appearance: Some(appearance),
                    ..Default::default()
                })
                .unwrap();
        }
        let reopened = SettingsStore::load(roots).unwrap();
        assert_eq!(
            reopened.snapshot().appearance.theme,
            crate::models::settings::ThemeMode::Light
        );
    }
}
