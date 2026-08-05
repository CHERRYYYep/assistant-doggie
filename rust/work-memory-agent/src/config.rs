use std::net::{Ipv4Addr, Ipv6Addr};
use thiserror::Error;

use url::{Host, Url};

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
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum LlmConfigurationError {
    #[error("OPENAI_API_MODE must be one of: chat_completions, responses")]
    InvalidApiMode { value: String },
    #[error("OPENAI_SITE must be a short single-line name")]
    InvalidSite,
    #[error("OPENAI_BASE_URL is required when OPENAI_SITE is not official")]
    MissingBaseUrl,
    #[error("OPENAI_BASE_URL must be an absolute http(s) URL, usually ending in /v1")]
    InvalidBaseUrl,
    #[error("OPENAI_BASE_URL must not contain credentials")]
    CredentialsInBaseUrl,
    #[error("OPENAI_BASE_URL must not contain query or fragment")]
    QueryOrFragmentInBaseUrl,
    #[error("custom API sites must use HTTPS; HTTP is allowed only for localhost")]
    InsecureRemoteBaseUrl,
}

fn normalize_base_url(value: &str) -> Result<String, LlmConfigurationError> {
    let cleaned = value.trim().trim_end_matches('/');
    let parsed = Url::parse(cleaned).map_err(|_| LlmConfigurationError::InvalidBaseUrl)?;

    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(LlmConfigurationError::InvalidBaseUrl);
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(LlmConfigurationError::QueryOrFragmentInBaseUrl);
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(LlmConfigurationError::CredentialsInBaseUrl);
    }

    let host = parsed.host().ok_or(LlmConfigurationError::InvalidBaseUrl)?;
    let is_local = match host {
        Host::Domain(hostname) => hostname.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(address) => address == Ipv4Addr::new(127, 0, 0, 1),
        Host::Ipv6(address) => address == Ipv6Addr::LOCALHOST,
    };
    if parsed.scheme() == "http" && !is_local {
        return Err(LlmConfigurationError::InsecureRemoteBaseUrl);
    }

    Ok(cleaned.to_owned())
}
