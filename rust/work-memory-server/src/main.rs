use std::env;
use std::time::Duration;

use work_memory_agent::{
    AgentHarness, LlmEndpointConfig, LlmHttpTransportConfig, StructuredOutputAdapter,
    UreqStructuredOutputTransport,
};
use work_memory_core::ConfidencePolicy;
use work_memory_runtime::{
    CanonicalRuntime, DEFAULT_STRUCTURED_OUTPUT_RETRIES, RUNTIME_PROMPT_VERSION,
    StructuredMemoryModel,
};
use work_memory_server::{DEFAULT_BIND_ADDRESS, Server, serve};
use work_memory_service::CanonicalService;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let database =
        env::var("RUST_CANONICAL_DB").unwrap_or_else(|_| "rust-work-memory.db".to_owned());
    let address =
        env::var("RUST_SERVER_ADDRESS").unwrap_or_else(|_| DEFAULT_BIND_ADDRESS.to_owned());
    let model_name = env::var("OPENAI_MODEL").map_err(|_| "OPENAI_MODEL is not configured")?;
    let site = env::var("OPENAI_SITE").ok();
    let base_url = env::var("OPENAI_BASE_URL").ok();
    let api_mode = env::var("OPENAI_API_MODE").ok();
    let endpoint =
        LlmEndpointConfig::resolve(site.as_deref(), base_url.as_deref(), api_mode.as_deref())?;
    let transport_config = LlmHttpTransportConfig::new(Duration::from_secs(
        env::var("OPENAI_TIMEOUT_SECONDS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(30),
    ))?;
    let model_transport = UreqStructuredOutputTransport::from_env(transport_config)?;
    let agent_transport = UreqStructuredOutputTransport::from_env(transport_config)?;
    let model = StructuredMemoryModel::new(
        StructuredOutputAdapter::new(endpoint.clone(), model_transport),
        &model_name,
        ConfidencePolicy::default(),
        DEFAULT_STRUCTURED_OUTPUT_RETRIES,
    )?;
    let harness = AgentHarness::new(endpoint, agent_transport);
    let service = CanonicalService::initialize(database)?;
    let runtime = CanonicalRuntime::new(
        service,
        model,
        harness,
        ConfidencePolicy::default(),
        &model_name,
        RUNTIME_PROMPT_VERSION,
    )?;
    let server = Server::new(runtime, model_name)?;
    eprintln!("work-memory-server listening on {address}");
    serve(address, server)?;
    Ok(())
}
