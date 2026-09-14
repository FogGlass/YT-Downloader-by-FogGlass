//! Foundational helpers: errors, paths, logging and filesystem access.

pub mod error;
pub mod fs_util;
pub mod logging;
pub mod paths;

pub use error::{AppError, AppResult};
