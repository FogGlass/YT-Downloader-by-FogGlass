//! The download engine: planning, queueing and execution.

pub mod manager;
pub mod plan;

pub use manager::DownloadManager;
pub use plan::{MergeSpec, StreamTask, TaskPlan};
