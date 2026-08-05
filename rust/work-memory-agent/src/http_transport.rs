use std::env;
use std::fmt::{self, Debug, Formatter};
use std::time::Duration;

use serde_json::Value;

use crate::{LlmHttpRequest, LlmHttpResponse, LlmTransportError, StructuredOutputTransport};

/// Default upper bound for one blocking HTTP request.
pub const DEFAULT_LLM_HTTP_TIMEOUT: Duration = Duration::from_secs(30);

/// Whether the concrete HTTP client should use the conventional process proxy environment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LlmHttpProxyMode {
    Environment,
    Disabled,
}

/// Non-secret settings for the concrete LLM HTTP transport.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LlmHttpTransportConfig {
    timeout: Duration,
    proxy_mode: LlmHttpProxyMode,
}

impl LlmHttpTransportConfig {
    /// Build transport settings and reject a timeout that would disable all progress.
    pub fn new(timeout: Duration) -> Result<Self, LlmTransportConfigurationError> {
        if timeout.is_zero() {
            return Err(LlmTransportConfigurationError::InvalidTimeout);
        }
        Ok(Self {
            timeout,
            proxy_mode: LlmHttpProxyMode::Environment,
        })
    }

    pub const fn timeout(self) -> Duration {
        self.timeout
    }

    pub const fn proxy_mode(self) -> LlmHttpProxyMode {
        self.proxy_mode
    }

    /// Disable environment proxy lookup, primarily for deterministic loopback tests.
    pub const fn without_proxy(mut self) -> Self {
        self.proxy_mode = LlmHttpProxyMode::Disabled;
        self
    }
}

impl Default for LlmHttpTransportConfig {
    fn default() -> Self {
        Self {
            timeout: DEFAULT_LLM_HTTP_TIMEOUT,
            proxy_mode: LlmHttpProxyMode::Environment,
        }
    }
}

/// Configuration failures that occur before a real HTTP request is attempted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LlmTransportConfigurationError {
    MissingApiKey,
    InvalidTimeout,
}

impl fmt::Display for LlmTransportConfigurationError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingApiKey => formatter.write_str("OPENAI_API_KEY is not configured"),
            Self::InvalidTimeout => {
                formatter.write_str("LLM HTTP timeout must be greater than zero")
            }
        }
    }
}

impl std::error::Error for LlmTransportConfigurationError {}

/// Synchronous HTTP transport backed by the mature `ureq` client.
///
/// The API key is intentionally private and is redacted from `Debug`. The transport does not
/// log request headers or include the key in any generated error message. `ureq` supplies TLS,
/// timeout, environment-proxy, `NO_PROXY`, and SOCKS handling; this type only adapts those
/// results to the existing `StructuredOutputTransport` boundary.
pub struct UreqStructuredOutputTransport {
    agent: ureq::Agent,
    api_key: String,
    timeout: Duration,
}

impl UreqStructuredOutputTransport {
    /// Construct a transport from an already-resolved secret.
    pub fn new(
        api_key: impl Into<String>,
        config: LlmHttpTransportConfig,
    ) -> Result<Self, LlmTransportConfigurationError> {
        let api_key = api_key.into().trim().to_owned();
        if api_key.is_empty() {
            return Err(LlmTransportConfigurationError::MissingApiKey);
        }

        // Config::builder starts from ureq's default Config, which reads the conventional
        // proxy environment variables and NO_PROXY. The selected timeout is non-secret and
        // deliberately applied at the agent level so every request uses the same bound.
        let mut builder = ureq::Agent::config_builder().timeout_global(Some(config.timeout()));
        if config.proxy_mode() == LlmHttpProxyMode::Disabled {
            builder = builder.proxy(None);
        }
        let agent: ureq::Agent = builder.build().into();

        Ok(Self {
            agent,
            api_key,
            timeout: config.timeout(),
        })
    }

    /// Construct a transport using `OPENAI_API_KEY` from the process environment.
    ///
    /// `.env` loading remains an application concern; this low-level adapter does not read
    /// dotenv files implicitly, which keeps ordinary tests and library use deterministic.
    pub fn from_env(
        config: LlmHttpTransportConfig,
    ) -> Result<Self, LlmTransportConfigurationError> {
        let api_key = env::var("OPENAI_API_KEY")
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .ok_or(LlmTransportConfigurationError::MissingApiKey)?;
        Self::new(api_key, config)
    }

    pub fn timeout(&self) -> Duration {
        self.timeout
    }
}

impl Debug for UreqStructuredOutputTransport {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UreqStructuredOutputTransport")
            .field("api_key", &"<redacted>")
            .field("timeout", &self.timeout)
            .finish_non_exhaustive()
    }
}

impl StructuredOutputTransport for UreqStructuredOutputTransport {
    fn send(&mut self, request: &LlmHttpRequest) -> Result<LlmHttpResponse, LlmTransportError> {
        let authorization = format!("Bearer {}", self.api_key);
        let mut response = self
            .agent
            .post(request.url())
            .header("Authorization", &authorization)
            .send_json(request.body())
            .map_err(map_ureq_error)?;

        let body = response
            .body_mut()
            .read_json::<Value>()
            .map_err(map_ureq_error)?;
        Ok(LlmHttpResponse::new(body))
    }
}

fn map_ureq_error(error: ureq::Error) -> LlmTransportError {
    match error {
        ureq::Error::StatusCode(status) => {
            LlmTransportError::http_status(status, "LLM endpoint returned an HTTP error")
        }
        _ => LlmTransportError::request("LLM HTTP request failed"),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn ureq_handles_python_socks_alias_without_environment_mutation() {
        let proxy = ureq::Proxy::new("socks://127.0.0.1:1080").expect("valid SOCKS proxy");
        assert_eq!(proxy.protocol(), ureq::ProxyProtocol::Socks5);
    }
}
