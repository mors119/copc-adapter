use serde::Serialize;

#[derive(Debug, Serialize)]
pub(crate) struct ParseError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

#[derive(Serialize)]
#[serde(untagged, bound = "T: Serialize")]
pub(crate) enum ParseResponse<T> {
    Success { ok: bool, value: T },
    Failure { ok: bool, error: ParseError },
}

impl<T> ParseResponse<T> {
    pub(crate) fn success(value: T) -> Self {
        Self::Success { ok: true, value }
    }

    pub(crate) fn failure(error: ParseError) -> Self {
        Self::Failure { ok: false, error }
    }
}

pub(crate) fn error(code: &'static str, message: impl Into<String>) -> ParseError {
    ParseError {
        code,
        message: message.into(),
    }
}
