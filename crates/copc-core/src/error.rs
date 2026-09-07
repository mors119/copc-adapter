use std::fmt::{Display, Formatter};

/// A typed failure raised while interpreting or decoding COPC data.
///
/// The error deliberately contains no browser, JavaScript, or serialization
/// concerns. Runtime adapters can translate its stable category into their
/// own transport representation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopcError {
    code: &'static str,
    message: String,
}

impl CopcError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl Display for CopcError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CopcError {}

pub type Result<T> = std::result::Result<T, CopcError>;
