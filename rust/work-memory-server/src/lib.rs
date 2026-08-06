//! Minimal HTTP/API boundary for the canonical Rust runtime.
//!
//! This deliberately uses the standard library rather than adding a web
//! framework to the MVP. It is a single-user, one-request-per-connection
//! server; production hardening can replace the listener without changing the
//! runtime/service boundary.

use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};

use serde_json::{Value, json};
use thiserror::Error;
use work_memory_agent::{AgentToolExecution, StructuredOutputTransport};
use work_memory_core::BucketStatus;
use work_memory_runtime::{
    CanonicalRuntime, RuntimeError, TurnOutcome, active_buckets, bucket_detail, search_memory,
};
use work_memory_store::RustChatMessage;

pub const DEFAULT_BIND_ADDRESS: &str = "127.0.0.1:8787";
const DEFAULT_LIST_LIMIT: usize = 20;
const MAX_LIST_LIMIT: usize = 100;
const MAX_HTTP_REQUEST_BYTES: usize = 1024 * 1024;

/// Parsed request used by the route dispatcher and direct API tests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: String,
    pub target: String,
    pub body: String,
}

impl HttpRequest {
    pub fn new(
        method: impl Into<String>,
        target: impl Into<String>,
        body: impl Into<String>,
    ) -> Self {
        Self {
            method: method.into(),
            target: target.into(),
            body: body.into(),
        }
    }
}

/// Response emitted by the route dispatcher.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub content_type: &'static str,
    pub body: String,
}

impl HttpResponse {
    fn json(status: u16, body: Value) -> Self {
        Self {
            status,
            content_type: "application/json; charset=utf-8",
            body: body.to_string(),
        }
    }

    fn html(body: &'static str) -> Self {
        Self {
            status: 200,
            content_type: "text/html; charset=utf-8",
            body: body.to_owned(),
        }
    }

    fn error(status: u16, message: impl Into<String>) -> Self {
        Self::json(status, json!({"ok": false, "error": message.into()}))
    }

    fn write_to(&self, stream: &mut TcpStream) -> io::Result<()> {
        let reason = status_reason(self.status);
        let body = self.body.as_bytes();
        write!(
            stream,
            "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
            self.status,
            reason,
            self.content_type,
            body.len()
        )?;
        stream.write_all(body)
    }
}

/// A generic server wrapper around the canonical runtime.
pub struct Server<M, T> {
    runtime: CanonicalRuntime<M, T>,
    default_model: String,
}

impl<M, T> Server<M, T> {
    pub fn new(
        runtime: CanonicalRuntime<M, T>,
        default_model: impl Into<String>,
    ) -> Result<Self, ServerError> {
        let default_model = default_model.into().trim().to_owned();
        if default_model.is_empty() {
            return Err(ServerError::EmptyDefaultModel);
        }
        Ok(Self {
            runtime,
            default_model,
        })
    }

    pub fn runtime(&self) -> &CanonicalRuntime<M, T> {
        &self.runtime
    }

    pub fn runtime_mut(&mut self) -> &mut CanonicalRuntime<M, T> {
        &mut self.runtime
    }
}

impl<M, T> Server<M, T>
where
    M: work_memory_runtime::MemoryModel,
    T: StructuredOutputTransport,
{
    /// Dispatch one request without performing network I/O.
    pub fn handle_request(&mut self, request: HttpRequest) -> HttpResponse {
        let (path, query) = split_target(&request.target);
        match (request.method.trim().to_ascii_uppercase().as_str(), path) {
            ("GET", "/") => HttpResponse::html(INDEX_HTML),
            ("GET", "/health") => {
                HttpResponse::json(200, json!({"ok": true, "service": "work-memory-server"}))
            }
            ("GET", "/api/buckets/active") => self.handle_active_buckets(query),
            ("GET", "/api/buckets/search") => self.handle_search(query),
            ("GET", path) if path.starts_with("/api/buckets/") => {
                self.handle_bucket_detail(&path["/api/buckets/".len()..])
            }
            ("POST", "/api/chat") => self.handle_chat(&request.body),
            ("POST", "/api/corrections/move") => self.handle_move(&request.body),
            ("POST", "/api/buckets/status") => self.handle_bucket_status(&request.body),
            _ => HttpResponse::error(404, "route not found"),
        }
    }

    fn handle_active_buckets(&self, query: &str) -> HttpResponse {
        let limit = match parse_limit(query) {
            Ok(limit) => limit,
            Err(error) => return HttpResponse::error(400, error),
        };
        match active_buckets(self.runtime.service(), limit) {
            Ok(mut body) => {
                body["ok"] = json!(true);
                HttpResponse::json(200, body)
            }
            Err(error) => runtime_error_response(error),
        }
    }

    fn handle_search(&self, query: &str) -> HttpResponse {
        let params = query_params(query);
        let Some(search_query) = params.get("q").filter(|value| !value.trim().is_empty()) else {
            return HttpResponse::error(400, "query parameter q must not be empty");
        };
        let limit = match parse_limit(query) {
            Ok(limit) => limit,
            Err(error) => return HttpResponse::error(400, error),
        };
        match search_memory(self.runtime.service(), search_query, limit) {
            Ok(mut body) => {
                body["ok"] = json!(true);
                HttpResponse::json(200, body)
            }
            Err(error) => runtime_error_response(error),
        }
    }

    fn handle_bucket_detail(&self, encoded_id: &str) -> HttpResponse {
        let bucket_id = percent_decode(encoded_id);
        if bucket_id.trim().is_empty() {
            return HttpResponse::error(400, "Bucket ID must not be empty");
        }
        match bucket_detail(self.runtime.service(), &bucket_id) {
            Ok(Some(detail)) => HttpResponse::json(200, json!({"ok": true, "detail": detail})),
            Ok(None) => HttpResponse::error(404, "Bucket does not exist"),
            Err(error) => runtime_error_response(error),
        }
    }

    fn handle_chat(&mut self, body: &str) -> HttpResponse {
        let value = match parse_json_object(body) {
            Ok(value) => value,
            Err(error) => return HttpResponse::error(400, error),
        };
        let Some(message) = value.get("message").and_then(Value::as_str) else {
            return HttpResponse::error(400, "message must be a string");
        };
        let model = value
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or(&self.default_model);
        let mut request = match work_memory_runtime::TurnRequest::new(message, model) {
            Ok(request) => request,
            Err(error) => return runtime_error_response(error),
        };
        if let Some(focus) = optional_string(&value, "focus_bucket_id") {
            request = request.with_focus_bucket(Some(focus));
        }
        request = request.with_confirmation(
            value
                .get("confirmation_granted")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        );
        if value.get("max_tool_rounds").is_some() || value.get("history_limit").is_some() {
            let max_rounds = match value
                .get("max_tool_rounds")
                .and_then(Value::as_u64)
                .map(usize::try_from)
                .transpose()
            {
                Ok(Some(value)) => value,
                Ok(None) | Err(_) => work_memory_agent::DEFAULT_AGENT_MAX_TOOL_ROUNDS,
            };
            let history_limit = match value
                .get("history_limit")
                .and_then(Value::as_u64)
                .map(usize::try_from)
                .transpose()
            {
                Ok(Some(value)) => value,
                Ok(None) | Err(_) => work_memory_runtime::DEFAULT_CHAT_HISTORY_LIMIT,
            };
            request = match request.with_limits(max_rounds, history_limit) {
                Ok(request) => request,
                Err(error) => return runtime_error_response(error),
            };
        }
        match self.runtime.run_turn(&request) {
            Ok(outcome) => HttpResponse::json(200, turn_to_value(&outcome)),
            Err(error) => runtime_error_response(error),
        }
    }

    fn handle_move(&mut self, body: &str) -> HttpResponse {
        let value = match parse_json_object(body) {
            Ok(value) => value,
            Err(error) => return HttpResponse::error(400, error),
        };
        let Some(entry_id) = value.get("entry_id").and_then(Value::as_str) else {
            return HttpResponse::error(400, "entry_id must be a string");
        };
        let Some(target_bucket_id) = value.get("target_bucket_id").and_then(Value::as_str) else {
            return HttpResponse::error(400, "target_bucket_id must be a string");
        };
        let command_text = value
            .get("command_text")
            .and_then(Value::as_str)
            .unwrap_or("Move Entry through Rust API.");
        match self
            .runtime
            .service_mut()
            .move_entry(entry_id, target_bucket_id, command_text)
        {
            Ok(entry) => HttpResponse::json(
                200,
                json!({
                    "ok": true,
                    "entry": {
                        "id": entry.id,
                        "bucket_id": entry.bucket_id,
                        "moved_from_bucket_id": entry.moved_from_bucket_id,
                    }
                }),
            ),
            Err(error) => runtime_error_response(RuntimeError::from(error)),
        }
    }

    fn handle_bucket_status(&mut self, body: &str) -> HttpResponse {
        let value = match parse_json_object(body) {
            Ok(value) => value,
            Err(error) => return HttpResponse::error(400, error),
        };
        let Some(bucket_id) = value.get("bucket_id").and_then(Value::as_str) else {
            return HttpResponse::error(400, "bucket_id must be a string");
        };
        let Some(status) = value.get("status").and_then(Value::as_str) else {
            return HttpResponse::error(400, "status must be a string");
        };
        let status = match parse_bucket_status(status) {
            Ok(status) => status,
            Err(error) => return HttpResponse::error(400, error),
        };
        match self
            .runtime
            .service_mut()
            .set_bucket_status(bucket_id, status)
        {
            Ok(bucket) => HttpResponse::json(
                200,
                json!({"ok": true, "bucket_id": bucket.id, "status": bucket.status.as_str()}),
            ),
            Err(error) => runtime_error_response(RuntimeError::from(error)),
        }
    }
}

/// Serve one generic runtime until the process is stopped.
pub fn serve<M, T>(address: impl ToSocketAddrs, mut server: Server<M, T>) -> io::Result<()>
where
    M: work_memory_runtime::MemoryModel,
    T: StructuredOutputTransport,
{
    let listener = TcpListener::bind(address)?;
    for stream in listener.incoming() {
        match stream {
            Ok(mut stream) => {
                if let Err(error) = handle_connection(&mut stream, &mut server) {
                    let _ = HttpResponse::error(400, error.to_string()).write_to(&mut stream);
                }
            }
            Err(error) => eprintln!("work-memory-server accept error: {error}"),
        }
    }
    Ok(())
}

fn handle_connection<M, T>(stream: &mut TcpStream, server: &mut Server<M, T>) -> io::Result<()>
where
    M: work_memory_runtime::MemoryModel,
    T: StructuredOutputTransport,
{
    let request = read_request(stream)?;
    let response = match request {
        Ok(request) => server.handle_request(request),
        Err(error) => HttpResponse::error(400, error),
    };
    response.write_to(stream)
}

fn read_request(stream: &mut TcpStream) -> io::Result<Result<HttpRequest, String>> {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 4096];
    let header_end;
    loop {
        let count = stream.read(&mut chunk)?;
        if count == 0 {
            return Ok(Err("request ended before headers".to_owned()));
        }
        buffer.extend_from_slice(&chunk[..count]);
        if buffer.len() > MAX_HTTP_REQUEST_BYTES {
            return Ok(Err("request is too large".to_owned()));
        }
        if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            header_end = position + 4;
            break;
        }
    }
    let header_text = String::from_utf8_lossy(&buffer[..header_end]).into_owned();
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default().to_owned();
    let target = request_parts.next().unwrap_or_default().to_owned();
    let version = request_parts.next().unwrap_or_default();
    if method.is_empty() || target.is_empty() || version != "HTTP/1.1" {
        return Ok(Err("invalid HTTP request line".to_owned()));
    }
    let mut content_length = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case("content-length") {
            let parsed = value.trim().parse().map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "invalid content length")
            })?;
            if content_length.is_some_and(|previous| previous != parsed) {
                return Ok(Err("conflicting content lengths".to_owned()));
            }
            content_length = Some(parsed);
        }
    }
    let content_length = content_length.unwrap_or(0);
    let request_end = header_end
        .checked_add(content_length)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "request is too large"))?;
    if request_end > MAX_HTTP_REQUEST_BYTES {
        return Ok(Err("request is too large".to_owned()));
    }
    while buffer.len() < request_end {
        let count = stream.read(&mut chunk)?;
        if count == 0 {
            return Ok(Err("request ended before body".to_owned()));
        }
        buffer.extend_from_slice(&chunk[..count]);
    }
    let body = String::from_utf8(buffer[header_end..request_end].to_vec())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "request body is not UTF-8"))?;
    Ok(Ok(HttpRequest::new(method, target, body)))
}

fn runtime_error_response(error: RuntimeError) -> HttpResponse {
    let status = match &error {
        RuntimeError::ConfirmationRequired
        | RuntimeError::EmptyField(_)
        | RuntimeError::InvalidLimit { .. }
        | RuntimeError::MissingBucket(_)
        | RuntimeError::MissingArchiveBucket
        | RuntimeError::Core(_)
        | RuntimeError::Contract(_)
        | RuntimeError::Json(_) => 400,
        RuntimeError::Canonical(error) if error.store_error().is_some() => 500,
        RuntimeError::Canonical(_)
        | RuntimeError::Store(_)
        | RuntimeError::Agent(_)
        | RuntimeError::Model(_) => 500,
    };
    HttpResponse::error(status, error.to_string())
}

fn turn_to_value(outcome: &TurnOutcome) -> Value {
    json!({
        "ok": true,
        "assistant": chat_message_to_value(&outcome.assistant),
        "tool_messages": outcome.tool_messages.iter().map(chat_message_to_value).collect::<Vec<_>>(),
        "tool_executions": outcome.tool_executions.iter().map(tool_execution_to_value).collect::<Vec<_>>(),
    })
}

fn chat_message_to_value(message: &RustChatMessage) -> Value {
    json!({
        "id": message.id,
        "sequence": message.sequence,
        "role": message.role.as_str(),
        "content": message.content,
        "tool_name": message.tool_name,
        "tool_call_id": message.tool_call_id,
        "details": message.details,
        "created_at": message.created_at.raw(),
    })
}

fn tool_execution_to_value(execution: &AgentToolExecution) -> Value {
    json!({
        "call_id": execution.call_id(),
        "name": execution.name(),
        "arguments": execution.arguments(),
        "output": execution.output(),
    })
}

fn parse_json_object(body: &str) -> Result<Value, String> {
    let value: Value =
        serde_json::from_str(body).map_err(|error| format!("invalid JSON: {error}"))?;
    if !value.is_object() {
        return Err("JSON body must be an object".to_owned());
    }
    Ok(value)
}

fn split_target(target: &str) -> (&str, &str) {
    target.split_once('?').unwrap_or((target, ""))
}

fn query_params(query: &str) -> std::collections::HashMap<String, String> {
    query
        .split('&')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let (key, value) = part.split_once('=').unwrap_or((part, ""));
            (percent_decode(key), percent_decode(value))
        })
        .collect()
}

fn parse_limit(query: &str) -> Result<usize, String> {
    let params = query_params(query);
    let limit = params
        .get("limit")
        .map(|value| value.parse::<usize>())
        .transpose()
        .map_err(|_| "limit must be a positive integer".to_owned())?
        .unwrap_or(DEFAULT_LIST_LIMIT);
    if !(1..=MAX_LIST_LIMIT).contains(&limit) {
        return Err(format!("limit must be between 1 and {MAX_LIST_LIMIT}"));
    }
    Ok(limit)
}

fn optional_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn parse_bucket_status(value: &str) -> Result<BucketStatus, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "active" => Ok(BucketStatus::Active),
        "paused" => Ok(BucketStatus::Paused),
        "archived" => Ok(BucketStatus::Archived),
        _ => Err("status must be active, paused, or archived".to_owned()),
    }
}

fn percent_decode(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2]))
        {
            output.push((high << 4 | low) as char);
            index += 3;
            continue;
        }
        output.push(if bytes[index] == b'+' {
            ' '
        } else {
            bytes[index] as char
        });
        index += 1;
    }
    output
}

fn hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn status_reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "Error",
    }
}

#[derive(Debug, Error)]
pub enum ServerError {
    #[error("default model must not be empty")]
    EmptyDefaultModel,
}

/// Small browser UI served from the same origin as the API.
pub const INDEX_HTML: &str = r#"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Doggie Work Memory</title>
  <style>
    body{font-family:system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;background:#f7f7f5;color:#202124}
    main{display:grid;grid-template-columns:2fr 1fr;gap:1rem}section{background:white;border:1px solid #ddd;border-radius:12px;padding:1rem}
    textarea{width:100%;min-height:120px;box-sizing:border-box}button{padding:.6rem 1rem;margin-top:.5rem;cursor:pointer}
    #messages{white-space:pre-wrap;min-height:200px}.bucket{padding:.5rem 0;border-bottom:1px solid #eee;font-size:.9rem}
    @media(max-width:700px){main{display:block}section{margin-bottom:1rem}}
  </style>
</head>
<body>
  <h1>Doggie 工作记忆</h1>
  <main>
    <section><div id="messages"></div><textarea id="input" placeholder="记录工作事实，或直接提问"></textarea><label><input type="checkbox" id="confirm"> 本轮允许确认追加/新建</label><br><button id="send">发送</button></section>
    <section><h2>活跃 Bucket</h2><div id="buckets">加载中…</div></section>
  </main>
<script>
const messages=document.querySelector('#messages'), input=document.querySelector('#input'), confirm=document.querySelector('#confirm'), buckets=document.querySelector('#buckets');
async function refresh(){const r=await fetch('/api/buckets/active');const d=await r.json();buckets.innerHTML=(d.buckets||[]).map(b=>`<div class="bucket"><b>${escapeHtml(b.title)}</b><br>${escapeHtml(b.summary||'')}</div>`).join('')||'暂无活跃 Bucket';}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
document.querySelector('#send').onclick=async()=>{const text=input.value.trim();if(!text)return;const confirmationGranted=confirm.checked;messages.textContent+='\n你：'+text+'\n';input.value='';confirm.checked=false;const r=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:text,confirmation_granted:confirmationGranted})});const d=await r.json();messages.textContent+='Doggie：'+(d.assistant?.content||d.error)+'\n';refresh();};
refresh();
</script>
</body></html>"#;

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use serde_json::{Value, json};
    use tempfile::tempdir;
    use work_memory_agent::{
        AgentHarness, LlmEndpointConfig, LlmHttpRequest, LlmHttpResponse, LlmTransportError,
        StructuredOutputTransport,
    };
    use work_memory_core::ConfidencePolicy;
    use work_memory_runtime::{CanonicalRuntime, MemoryModel, RuntimeError};
    use work_memory_service::CanonicalServiceError;
    use work_memory_store::StoreError;

    use super::{HttpRequest, Server, runtime_error_response};

    struct Model;

    impl MemoryModel for Model {
        type Error = String;

        fn classify(
            &mut self,
            _text: &str,
            _candidates: &[work_memory_core::BucketView],
        ) -> Result<work_memory_core::ClassificationResult, Self::Error> {
            panic!("model not used by route test")
        }

        fn extract(
            &mut self,
            _text: &str,
        ) -> Result<work_memory_core::ExtractionResult, Self::Error> {
            panic!("model not used by route test")
        }
    }

    struct Transport {
        responses: VecDeque<Value>,
    }

    impl StructuredOutputTransport for Transport {
        fn send(
            &mut self,
            _request: &LlmHttpRequest,
        ) -> Result<LlmHttpResponse, LlmTransportError> {
            Ok(LlmHttpResponse::new(
                self.responses.pop_front().unwrap_or_else(|| {
                    json!({"status":"completed","output":[{"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"ok"}]}]})
                }),
            ))
        }
    }

    fn server() -> Server<Model, Transport> {
        let database = tempdir().expect("tempdir");
        let service =
            work_memory_service::CanonicalService::initialize(database.path().join("canonical.db"))
                .expect("service");
        let endpoint = LlmEndpointConfig::resolve(Some("official"), None, Some("responses"))
            .expect("endpoint");
        let runtime = CanonicalRuntime::new(
            service,
            Model,
            AgentHarness::new(
                endpoint,
                Transport {
                    responses: VecDeque::new(),
                },
            ),
            ConfidencePolicy::default(),
            "fixture-model",
            "server-test-v1",
        )
        .expect("runtime");
        Server::new(runtime, "fixture-agent").expect("server")
    }

    #[test]
    fn health_and_static_ui_routes_are_available() {
        let mut server = server();
        let health = server.handle_request(HttpRequest::new("GET", "/health", ""));
        assert_eq!(health.status, 200);
        assert!(health.body.contains("work-memory-server"));
        let ui = server.handle_request(HttpRequest::new("GET", "/", ""));
        assert_eq!(ui.content_type, "text/html; charset=utf-8");
        assert!(ui.body.contains("Doggie 工作记忆"));
        assert!(ui.body.contains("confirmation_granted"));
    }

    #[test]
    fn invalid_search_and_chat_requests_are_rejected_without_panic() {
        let mut server = server();
        let search = server.handle_request(HttpRequest::new("GET", "/api/buckets/search", ""));
        assert_eq!(search.status, 400);
        let chat = server.handle_request(HttpRequest::new("POST", "/api/chat", "{}"));
        assert_eq!(chat.status, 400);
    }

    #[test]
    fn canonical_read_and_mutation_routes_return_json_errors() {
        let mut server = server();

        let active =
            server.handle_request(HttpRequest::new("GET", "/api/buckets/active?limit=1", ""));
        assert_eq!(active.status, 200);
        let active_body: Value = serde_json::from_str(&active.body).expect("active JSON");
        assert_eq!(active_body["ok"], true);
        assert!(active_body["buckets"].is_array());

        let search = server.handle_request(HttpRequest::new(
            "GET",
            "/api/buckets/search?q=sqlite&limit=1",
            "",
        ));
        assert_eq!(search.status, 200);
        let search_body: Value = serde_json::from_str(&search.body).expect("search JSON");
        assert_eq!(search_body["ok"], true);
        assert!(search_body["results"].is_array());

        let detail =
            server.handle_request(HttpRequest::new("GET", "/api/buckets/missing-bucket", ""));
        assert_eq!(detail.status, 404);

        let invalid_status = server.handle_request(HttpRequest::new(
            "POST",
            "/api/buckets/status",
            r#"{"bucket_id":"missing-bucket","status":"unknown"}"#,
        ));
        assert_eq!(invalid_status.status, 400);

        let missing_move_fields = server.handle_request(HttpRequest::new(
            "POST",
            "/api/corrections/move",
            r#"{"entry_id":"entry"}"#,
        ));
        assert_eq!(missing_move_fields.status, 400);
    }

    #[test]
    fn canonical_store_failures_are_internal_server_errors() {
        let response = runtime_error_response(RuntimeError::Canonical(
            CanonicalServiceError::Store(StoreError::InvalidLimit(0)),
        ));
        assert_eq!(response.status, 500);
    }
}
