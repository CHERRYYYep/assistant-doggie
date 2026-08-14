use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io;
use std::path::Path;
use std::time::Duration;

use doggie_agent_runtime::{AgentHarness, DEFAULT_AGENT_MAX_TOOL_ROUNDS};
use doggie_application::CanonicalService;
use doggie_domain::ConfidencePolicy;
use doggie_engine::{
    CanonicalRuntime, DEFAULT_STRUCTURED_OUTPUT_RETRIES, RUNTIME_PROMPT_VERSION,
    StructuredMemoryModel,
};
use doggie_llm::{
    LlmEndpointConfig, LlmHttpTransportConfig, StructuredOutputAdapter,
    UreqStructuredOutputTransport,
};
use doggie_local_web::{AgentChatResponder, DEFAULT_BIND_ADDRESS, Server, serve};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dotenv = load_dotenv(".env")?;
    let database = optional_config("DOGGIE_DATABASE_PATH", &dotenv)
        .or_else(|| optional_config("RUST_DATABASE_PATH", &dotenv))
        .unwrap_or_else(|| "doggie.db".to_owned());
    let address = optional_config("DOGGIE_SERVER_ADDRESS", &dotenv)
        .or_else(|| optional_config("RUST_SERVER_ADDRESS", &dotenv))
        .unwrap_or_else(|| DEFAULT_BIND_ADDRESS.to_owned());
    let model_name = required_config("OPENAI_MODEL", &dotenv)?;
    let site = optional_config("OPENAI_SITE", &dotenv);
    let base_url = optional_config("OPENAI_BASE_URL", &dotenv);
    let api_mode = optional_config("OPENAI_API_MODE", &dotenv);
    let endpoint =
        LlmEndpointConfig::resolve(site.as_deref(), base_url.as_deref(), api_mode.as_deref())?;
    let transport_config = LlmHttpTransportConfig::new(Duration::from_secs(
        optional_config("OPENAI_TIMEOUT_SECONDS", &dotenv)
            .and_then(|value| value.parse().ok())
            .unwrap_or(30),
    ))?;
    let api_key = required_config("OPENAI_API_KEY", &dotenv)?;
    let model_transport = UreqStructuredOutputTransport::new(api_key.clone(), transport_config)?;
    let chat_transport = UreqStructuredOutputTransport::new(api_key, transport_config)?;
    let model = StructuredMemoryModel::new(
        StructuredOutputAdapter::new(endpoint.clone(), model_transport),
        &model_name,
        ConfidencePolicy::default(),
        DEFAULT_STRUCTURED_OUTPUT_RETRIES,
    )?;
    let service = CanonicalService::initialize(database)?;
    let runtime = CanonicalRuntime::new(
        service,
        model,
        ConfidencePolicy::default(),
        &model_name,
        RUNTIME_PROMPT_VERSION,
    )?;
    let chat_responder = AgentChatResponder::new(
        AgentHarness::new(endpoint, chat_transport),
        model_name.clone(),
        DEFAULT_AGENT_MAX_TOOL_ROUNDS,
    )?;
    let server = Server::with_chat_responder(runtime, chat_responder);
    eprintln!("doggie-local-web listening on {address}");
    serve(address, server)?;
    Ok(())
}

fn required_config(key: &str, dotenv: &BTreeMap<String, String>) -> Result<String, io::Error> {
    optional_config(key, dotenv).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{key} is not configured; set it in the environment or .env"),
        )
    })
}

fn optional_config(key: &str, dotenv: &BTreeMap<String, String>) -> Option<String> {
    env::var(key)
        .ok()
        .or_else(|| dotenv.get(key).cloned())
        .and_then(|value| {
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_owned())
        })
}

fn load_dotenv(path: impl AsRef<Path>) -> Result<BTreeMap<String, String>, io::Error> {
    let path = path.as_ref();
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(error),
    };
    parse_dotenv(&contents, path.display().to_string())
}

fn parse_dotenv(contents: &str, source: String) -> Result<BTreeMap<String, String>, io::Error> {
    let mut values = BTreeMap::new();
    for (line_number, raw_line) in contents.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((raw_key, raw_value)) = line.split_once('=') else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("{source}:{} must use KEY=VALUE syntax", line_number + 1),
            ));
        };
        let key = raw_key.trim();
        if key.is_empty()
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("{source}:{} has an invalid variable name", line_number + 1),
            ));
        }
        values.insert(key.to_owned(), parse_dotenv_value(raw_value.trim()));
    }
    Ok(values)
}

fn parse_dotenv_value(value: &str) -> String {
    if value.len() >= 2 {
        let first = value.as_bytes()[0];
        let last = value.as_bytes()[value.len() - 1];
        if (first == b'\'' && last == b'\'') || (first == b'"' && last == b'"') {
            return value[1..value.len() - 1].to_owned();
        }
    }
    value.to_owned()
}

#[cfg(test)]
mod tests {
    use super::parse_dotenv;

    #[test]
    fn dotenv_parser_supports_comments_exports_and_quotes() {
        let values = parse_dotenv(
            "# comment\nexport OPENAI_MODEL=smoke-model\nOPENAI_API_KEY='secret'\n",
            ".env".to_owned(),
        )
        .expect("dotenv values");

        assert_eq!(values["OPENAI_MODEL"], "smoke-model");
        assert_eq!(values["OPENAI_API_KEY"], "secret");
    }
}
