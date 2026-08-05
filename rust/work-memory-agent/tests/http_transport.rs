use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use work_memory_agent::{
    LlmEndpointConfig, LlmError, LlmHttpTransportConfig, LlmTransportError,
    StructuredOutputAdapter, UreqStructuredOutputTransport,
};
use work_memory_contracts::{BucketSummaryContract, StructuredOutputContract};

struct MockResponse {
    status: u16,
    body: String,
    delay: Duration,
}

impl MockResponse {
    fn json(status: u16, body: Value) -> Self {
        Self {
            status,
            body: body.to_string(),
            delay: Duration::ZERO,
        }
    }

    fn raw(status: u16, body: impl Into<String>) -> Self {
        Self {
            status,
            body: body.into(),
            delay: Duration::ZERO,
        }
    }

    fn delayed(status: u16, body: Value, delay: Duration) -> Self {
        Self {
            status,
            body: body.to_string(),
            delay,
        }
    }
}

#[derive(Debug)]
struct CapturedRequest {
    method: String,
    target: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

struct MockServer {
    base_url: String,
    captured: Arc<Mutex<Vec<CapturedRequest>>>,
    handle: JoinHandle<()>,
}

impl MockServer {
    fn start(responses: Vec<MockResponse>) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind mock server");
        let address = listener.local_addr().expect("mock server address");
        let captured = Arc::new(Mutex::new(Vec::new()));
        let captured_for_thread = Arc::clone(&captured);

        let handle = thread::spawn(move || {
            for response in responses {
                let (mut stream, _) = listener.accept().expect("accept mock request");
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .expect("set mock read timeout");
                let request = read_request(&mut stream);
                captured_for_thread
                    .lock()
                    .expect("capture lock")
                    .push(request);

                if !response.delay.is_zero() {
                    thread::sleep(response.delay);
                }
                let body = response.body.as_bytes();
                let status_text = match response.status {
                    200 => "OK",
                    401 => "Unauthorized",
                    408 => "Request Timeout",
                    409 => "Conflict",
                    429 => "Too Many Requests",
                    500 => "Internal Server Error",
                    _ => "Test Status",
                };
                let response_head = format!(
                    "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response.status,
                    status_text,
                    body.len()
                );
                let _ = stream.write_all(response_head.as_bytes());
                let _ = stream.write_all(body);
                let _ = stream.flush();
            }
        });

        Self {
            base_url: format!("http://{address}/v1"),
            captured,
            handle,
        }
    }

    fn finish(self) -> Vec<CapturedRequest> {
        self.handle.join().expect("mock server thread");
        Arc::try_unwrap(self.captured)
            .expect("mock server capture references released")
            .into_inner()
            .expect("capture lock")
    }
}

fn read_request(stream: &mut TcpStream) -> CapturedRequest {
    let mut bytes = Vec::new();
    let header_end = loop {
        let mut chunk = [0_u8; 1024];
        let read = stream.read(&mut chunk).expect("read mock request");
        assert!(read > 0, "mock client closed before sending headers");
        bytes.extend_from_slice(&chunk[..read]);
        if let Some(index) = find_header_end(&bytes) {
            break index;
        }
    };

    let header_text = String::from_utf8_lossy(&bytes[..header_end]);
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().expect("request line");
    let mut request_line_parts = request_line.split_whitespace();
    let method = request_line_parts.next().unwrap_or_default().to_owned();
    let target = request_line_parts.next().unwrap_or_default().to_owned();
    let headers = lines
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            Some((name.to_ascii_lowercase(), value.trim().to_owned()))
        })
        .collect::<BTreeMap<_, _>>();
    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let body_start = header_end + 4;
    while bytes.len() < body_start + content_length {
        let mut chunk = [0_u8; 1024];
        let read = stream.read(&mut chunk).expect("read mock request body");
        assert!(read > 0, "mock client closed before sending request body");
        bytes.extend_from_slice(&chunk[..read]);
    }

    CapturedRequest {
        method,
        target,
        headers,
        body: bytes[body_start..body_start + content_length].to_vec(),
    }
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

fn local_endpoint(server: &MockServer) -> LlmEndpointConfig {
    LlmEndpointConfig::resolve(Some("local"), Some(&server.base_url), Some("responses"))
        .expect("local endpoint config")
}

fn test_transport(timeout: Duration) -> UreqStructuredOutputTransport {
    let config = LlmHttpTransportConfig::new(timeout)
        .expect("test timeout")
        .without_proxy();
    UreqStructuredOutputTransport::new("fixture-key-not-a-secret", config).expect("test transport")
}

fn completed_summary(summary: &str) -> Value {
    json!({
        "status": "completed",
        "output": [{
            "type": "message",
            "content": [{
                "type": "output_text",
                "text": json!({"summary": summary}).to_string()
            }]
        }]
    })
}

fn run_request(
    server: &MockServer,
    transport: UreqStructuredOutputTransport,
    max_retries: usize,
) -> Result<BucketSummaryContract, LlmError> {
    let endpoint = local_endpoint(server);
    let mut adapter = StructuredOutputAdapter::new(endpoint, transport);
    adapter.parse::<BucketSummaryContract>(
        "test-model",
        "system prompt",
        "user prompt",
        max_retries,
    )
}

#[test]
fn posts_json_with_bearer_auth_and_reads_a_structured_response() {
    let server = MockServer::start(vec![MockResponse::json(
        200,
        completed_summary("transport ok"),
    )]);
    let result = run_request(&server, test_transport(Duration::from_secs(2)), 0)
        .expect("mock response should parse");
    assert_eq!(result.inner().summary(), "transport ok");
    assert_eq!(server.finish().len(), 1);

    let server = MockServer::start(vec![MockResponse::json(200, completed_summary("body"))]);
    let endpoint = local_endpoint(&server);
    let secret = "fixture-key-not-a-secret";
    let transport = UreqStructuredOutputTransport::new(
        secret,
        LlmHttpTransportConfig::new(Duration::from_secs(2))
            .expect("test timeout")
            .without_proxy(),
    )
    .expect("test transport");
    let debug = format!("{transport:?}");
    assert!(!debug.contains(secret));
    let mut adapter = StructuredOutputAdapter::new(endpoint, transport);
    let _ = adapter
        .parse::<BucketSummaryContract>("test-model", "system prompt", "user prompt", 0)
        .expect("mock response should parse");
    let requests = server.finish();
    assert_eq!(requests.len(), 1);

    let request = &requests[0];
    assert_eq!(request.method, "POST");
    assert_eq!(request.target, "/v1/responses");
    assert_eq!(
        request.headers.get("authorization"),
        Some(&format!("Bearer {secret}"))
    );
    assert_eq!(
        request
            .headers
            .get("content-type")
            .map(String::as_str)
            .map(|value| value.split(';').next().unwrap_or_default()),
        Some("application/json")
    );
    let body: Value = serde_json::from_slice(&request.body).expect("request JSON");
    assert_eq!(body.get("model"), Some(&json!("test-model")));
    assert_eq!(
        body.get("input").and_then(Value::as_array).map(Vec::len),
        Some(2)
    );
    assert_eq!(
        body.pointer("/text/format/type"),
        Some(&json!("json_schema"))
    );
    assert_eq!(
        body.pointer("/text/format/name"),
        Some(&json!(BucketSummaryContract::SCHEMA_NAME))
    );
}

#[test]
fn maps_http_statuses_and_preserves_retry_policy_at_the_adapter_boundary() {
    for (status, max_retries, expected_attempts) in [(401, 1, 1), (429, 1, 2), (500, 1, 2)] {
        let server = MockServer::start(
            (0..expected_attempts)
                .map(|_| MockResponse::json(status, json!({"error": "not exposed"})))
                .collect(),
        );
        let endpoint = local_endpoint(&server);
        let mut adapter =
            StructuredOutputAdapter::new(endpoint, test_transport(Duration::from_secs(2)));
        let error = adapter
            .parse::<BucketSummaryContract>(
                "test-model",
                "system prompt",
                "user prompt",
                max_retries,
            )
            .expect_err("status response should fail");
        assert_eq!(error.attempts(), Some(expected_attempts));
        assert!(matches!(
            error.last_error(),
            Some(LlmError::Transport(LlmTransportError::HttpStatus {
                status: observed,
                ..
            })) if *observed == status
        ));
        assert!(!format!("{error:?}").contains("fixture-key-not-a-secret"));
        assert_eq!(server.finish().len(), expected_attempts);
    }
}

#[test]
fn invalid_json_response_is_a_sanitized_retryable_transport_failure() {
    let server = MockServer::start(vec![MockResponse::raw(200, "{not valid JSON")]);
    let endpoint = local_endpoint(&server);
    let mut adapter =
        StructuredOutputAdapter::new(endpoint, test_transport(Duration::from_secs(2)));
    let error = adapter
        .parse::<BucketSummaryContract>("test-model", "system prompt", "user prompt", 0)
        .expect_err("invalid JSON should fail");
    assert!(matches!(
        error.last_error(),
        Some(LlmError::Transport(LlmTransportError::Request { message }))
            if message == "LLM HTTP request failed"
    ));
    assert_eq!(server.finish().len(), 1);
}

#[test]
fn timeout_is_mapped_without_exposing_request_details() {
    let server = MockServer::start(vec![MockResponse::delayed(
        200,
        completed_summary("too late"),
        Duration::from_millis(200),
    )]);
    let endpoint = local_endpoint(&server);
    let mut adapter =
        StructuredOutputAdapter::new(endpoint, test_transport(Duration::from_millis(40)));
    let started = Instant::now();
    let error = adapter
        .parse::<BucketSummaryContract>("test-model", "system prompt", "user prompt", 0)
        .expect_err("slow mock should time out");
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(matches!(
        error.last_error(),
        Some(LlmError::Transport(LlmTransportError::Request { message }))
            if message == "LLM HTTP request failed"
    ));
    assert_eq!(server.finish().len(), 1);
}

#[test]
fn transport_configuration_rejects_empty_keys_and_zero_timeout() {
    assert!(matches!(
        LlmHttpTransportConfig::new(Duration::ZERO),
        Err(work_memory_agent::LlmTransportConfigurationError::InvalidTimeout)
    ));
    assert!(matches!(
        UreqStructuredOutputTransport::new("  ", LlmHttpTransportConfig::default()),
        Err(work_memory_agent::LlmTransportConfigurationError::MissingApiKey)
    ));
}
