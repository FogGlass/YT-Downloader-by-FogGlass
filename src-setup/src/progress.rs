//! Progress reporting shared by the installer and the uninstaller.
//!
//! Emits a `setup:progress` event carrying both the overall percentage and the state
//! of every step, so the window can render an honest step list instead of a single
//! anonymous bar. Events are throttled: a 600 MB extraction would otherwise push tens
//! of thousands of messages at the webview.

use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Minimum gap between two progress events.
const EMIT_INTERVAL: Duration = Duration::from_millis(80);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StepState {
    Pending,
    Active,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupStep {
    pub id: String,
    pub label: String,
    pub state: StepState,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupProgress {
    pub percent: f64,
    pub steps: Vec<SetupStep>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupFinished {
    pub ok: bool,
    pub mode: String,
    pub install_dir: Option<String>,
    pub error: Option<String>,
    pub detail: Option<String>,
    pub app_data_kept: bool,
    pub downloads_kept: bool,
    pub kept_data_path: Option<String>,
}

pub struct ProgressReporter {
    app: AppHandle,
    mode: &'static str,
    steps: Vec<SetupStep>,
    last_emit: Instant,
    percent: f64,
    detail: String,
}

impl ProgressReporter {
    pub fn new(app: AppHandle, mode: &'static str, definitions: &[(&str, &str)]) -> Self {
        let steps = definitions
            .iter()
            .map(|(id, label)| SetupStep {
                id: (*id).to_string(),
                label: (*label).to_string(),
                state: StepState::Pending,
            })
            .collect();

        Self {
            app,
            mode,
            steps,
            // Start "long ago" so the first update is always sent.
            last_emit: Instant::now() - EMIT_INTERVAL,
            percent: 0.0,
            detail: String::new(),
        }
    }

    pub fn begin(&mut self, index: usize, detail: &str) {
        if let Some(step) = self.steps.get_mut(index) {
            step.state = StepState::Active;
        }
        self.detail = detail.to_string();
        self.force();
    }

    pub fn complete(&mut self, index: usize) {
        if let Some(step) = self.steps.get_mut(index) {
            step.state = StepState::Done;
        }
        self.emit(false);
    }

    pub fn fail(&mut self, index: usize) {
        if let Some(step) = self.steps.get_mut(index) {
            step.state = StepState::Failed;
        }
        self.force();
    }

    /// Update the overall completion and the "what is happening now" line.
    pub fn set(&mut self, percent: f64, detail: &str) {
        self.percent = percent.clamp(0.0, 1.0);
        if !detail.is_empty() {
            self.detail = detail.to_string();
        }
        self.emit(false);
    }

    pub fn force(&mut self) {
        self.emit(true);
    }

    fn emit(&mut self, force: bool) {
        if !force && self.last_emit.elapsed() < EMIT_INTERVAL {
            return;
        }
        self.last_emit = Instant::now();
        let _ = self.app.emit(
            "setup:progress",
            SetupProgress {
                percent: self.percent,
                steps: self.steps.clone(),
                detail: self.detail.clone(),
            },
        );
    }

    pub fn finish(&self, payload: SetupFinished) {
        let _ = self.app.emit("setup:finished", payload);
    }

    pub fn mode(&self) -> &'static str {
        self.mode
    }
}
