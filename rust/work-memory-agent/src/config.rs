use std::error::Error;
use std::fmt::{self, Display, Formatter};

pub const OFFICIAL_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";

/// Structured-output API surface supported by an official or compatible site.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LlmApiMode {
    Responses,
    ChatCompletions,
}

impl LlmApiMode {
    pub fn parse(value: Option<&str>) -> Result<Self, LlmConfigurationError> {
        let normalized = value.unwrap_or("responses").trim().to_ascii_lowercase();
        match normalized.as_str() {
            "responses" | "response" => Ok(Self::Responses),
            "chat" | "chat_completions" | "chat-completions" => Ok(Self::ChatCompletions),
            _ => Err(LlmConfigurationError::InvalidApiMode { value: normalized }),
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Responses => "responses",
            Self::ChatCompletions => "chat_completions",
        }
    }

    pub const fn path(self) -> &'static str {
        match self {
            Self::Responses => "responses",
            Self::ChatCompletions => "chat/completions",
        }
    }
}

/// Non-secret endpoint settings for one official or compatible API site.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LlmEndpointConfig {
    site: String,
    base_url: String,
    api_mode: LlmApiMode,
}

impl LlmEndpointConfig {
    /// Resolve explicit settings with the same defaults as the Python runtime.
    pub fn resolve(
        site: Option<&str>,
        base_url: Option<&str>,
        api_mode: Option<&str>,
    ) -> Result<Self, LlmConfigurationError> {
        let requested_base_url = base_url.map(str::trim).filter(|value| !value.is_empty());
        let site = match site.map(str::trim).filter(|value| !value.is_empty()) {
            Some(value) => value.to_owned(),
            None if requested_base_url.is_some() => "custom".to_owned(),
            None => "official".to_owned(),
        };

        if site.len() > 100 || site.contains('\r') || site.contains('\n') {
            return Err(LlmConfigurationError::InvalidSite);
        }

        let api_mode = LlmApiMode::parse(api_mode)?;
        if site.eq_ignore_ascii_case("official") {
            return Ok(Self {
                site: "official".to_owned(),
                base_url: OFFICIAL_OPENAI_BASE_URL.to_owned(),
                api_mode,
            });
        }

        let base_url = requested_base_url.ok_or(LlmConfigurationError::MissingBaseUrl)?;
        Ok(Self {
            site,
            base_url: normalize_base_url(base_url)?,
            api_mode,
        })
    }

    pub fn site(&self) -> &str {
        &self.site
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub const fn api_mode(&self) -> LlmApiMode {
        self.api_mode
    }

    pub fn is_official(&self) -> bool {
        self.site.eq_ignore_ascii_case("official")
    }

    pub fn request_url(&self) -> String {
        format!("{}/{}", self.base_url, self.api_mode.path())
    }
}

/// Invalid non-secret LLM endpoint configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LlmConfigurationError {
    InvalidApiMode { value: String },
    InvalidSite,
    MissingBaseUrl,
    InvalidBaseUrl,
    CredentialsInBaseUrl,
    QueryOrFragmentInBaseUrl,
    InsecureRemoteBaseUrl,
}

impl Display for LlmConfigurationError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidApiMode { .. } => {
                formatter.write_str("OPENAI_API_MODE must be one of: chat_completions, responses")
            }
            Self::InvalidSite => {
                formatter.write_str("OPENAI_SITE must be a short single-line name")
            }
            Self::MissingBaseUrl => {
                formatter.write_str("OPENAI_BASE_URL is required when OPENAI_SITE is not official")
            }
            Self::InvalidBaseUrl => formatter.write_str(
                "OPENAI_BASE_URL must be an absolute http(s) URL, usually ending in /v1",
            ),
            Self::CredentialsInBaseUrl => {
                formatter.write_str("OPENAI_BASE_URL must not contain credentials")
            }
            Self::QueryOrFragmentInBaseUrl => {
                formatter.write_str("OPENAI_BASE_URL must not contain query or fragment")
            }
            Self::InsecureRemoteBaseUrl => formatter
                .write_str("custom API sites must use HTTPS; HTTP is allowed only for localhost"),
        }
    }
}

impl Error for LlmConfigurationError {}

fn normalize_base_url(value: &str) -> Result<String, LlmConfigurationError> {
    let cleaned = value.trim().trim_end_matches('/');
    let (scheme, remainder) = cleaned
        .split_once("://")
        .ok_or(LlmConfigurationError::InvalidBaseUrl)?;
    let scheme = scheme.to_ascii_lowercase();
    if !matches!(scheme.as_str(), "http" | "https") || remainder.is_empty() {
        return Err(LlmConfigurationError::InvalidBaseUrl);
    }
    if remainder.contains('?') || remainder.contains('#') {
        return Err(LlmConfigurationError::QueryOrFragmentInBaseUrl);
    }

    let authority = remainder.split('/').next().unwrap_or_default();
    if authority.is_empty() || authority.chars().any(char::is_whitespace) {
        return Err(LlmConfigurationError::InvalidBaseUrl);
    }
    if authority.contains('@') {
        return Err(LlmConfigurationError::CredentialsInBaseUrl);
    }

    let hostname = authority_hostname(authority)?;
    let is_local = matches!(
        hostname.to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "::1"
    );
    if scheme == "http" && !is_local {
        return Err(LlmConfigurationError::InsecureRemoteBaseUrl);
    }

    Ok(cleaned.to_owned())
}

fn authority_hostname(authority: &str) -> Result<&str, LlmConfigurationError> {
    if let Some(remainder) = authority.strip_prefix('[') {
        let closing = remainder
            .find(']')
            .ok_or(LlmConfigurationError::InvalidBaseUrl)?;
        let hostname = &remainder[..closing];
        let suffix = &remainder[closing + 1..];
        if hostname.is_empty()
            || (!suffix.is_empty()
                && (!suffix.starts_with(':')
                    || suffix[1..].is_empty()
                    || !suffix[1..].bytes().all(|byte| byte.is_ascii_digit())))
        {
            return Err(LlmConfigurationError::InvalidBaseUrl);
        }
        return Ok(hostname);
    }

    if authority.matches(':').count() > 1 {
        return Err(LlmConfigurationError::InvalidBaseUrl);
    }
    let (hostname, port) = authority
        .split_once(':')
        .map_or((authority, None), |(hostname, port)| (hostname, Some(port)));
    if hostname.is_empty()
        || port.is_some_and(|value| {
            value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit())
        })
    {
        return Err(LlmConfigurationError::InvalidBaseUrl);
    }
    Ok(hostname)
}
