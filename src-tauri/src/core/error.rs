//! Error type shared by every backend layer.
//!
//! Errors are serialised into a small, stable JSON envelope so the UI can always
//! render something meaningful — a friendly sentence plus the technical detail that
//! Expert Mode reveals.

use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Message(String),

    #[error("{0}")]
    NotFound(String),

    #[error("{0}")]
    Runtime(String),

    #[error("{0}")]
    Process(String),

    /// A failure that has been classified, carrying actionable guidance.
    ///
    /// `hint` is what turns "Failed to decrypt with DPAPI" into "Edge protects its
    /// cookies with app-bound encryption — export cookies.txt or continue without
    /// cookies", so it must survive all the way to the interface.
    #[error("{summary}")]
    Classified {
        kind: String,
        summary: String,
        hint: Option<String>,
        detail: Option<String>,
    },

    #[error("文件系统错误：{0}")]
    Io(#[from] std::io::Error),

    #[error("数据解析失败：{0}")]
    Json(#[from] serde_json::Error),
}

impl AppError {
    pub fn message(message: impl Into<String>) -> Self {
        Self::Message(message.into())
    }

    pub fn runtime(message: impl Into<String>) -> Self {
        Self::Runtime(message.into())
    }

    pub fn process(message: impl Into<String>) -> Self {
        Self::Process(message.into())
    }

    /// Stable machine-readable discriminator used by the frontend.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Message(_) => "message",
            Self::NotFound(_) => "not_found",
            Self::Runtime(_) => "runtime",
            Self::Process(_) => "process",
            Self::Classified { .. } => "classified",
            Self::Io(_) => "io",
            Self::Json(_) => "json",
        }
    }

    /// Actionable guidance, when the failure has any.
    pub fn hint(&self) -> Option<&str> {
        match self {
            Self::Classified { hint, .. } => hint.as_deref(),
            _ => None,
        }
    }
}

impl From<String> for AppError {
    fn from(value: String) -> Self {
        Self::Message(value)
    }
}

impl From<&str> for AppError {
    fn from(value: &str) -> Self {
        Self::Message(value.to_owned())
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("AppError", 5)?;
        state.serialize_field("kind", self.kind())?;
        state.serialize_field("message", &self.to_string())?;
        state.serialize_field("hint", &self.hint())?;
        state.serialize_field("detail", &format!("{self:?}"))?;
        state.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;
