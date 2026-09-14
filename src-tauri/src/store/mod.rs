//! Persistence for settings, history and favourites.
//!
//! Everything is a plain JSON document inside the application's data folder. Writes
//! go through a temporary file and a rename so an interrupted save can never corrupt
//! a library.

pub mod favorites;
pub mod history;
pub mod settings;

pub use favorites::FavoritesStore;
pub use history::HistoryStore;
pub use settings::SettingsStore;
