//! Minimal HTTP/API boundary for the canonical Rust runtime.
//!
//! This deliberately uses the standard library rather than adding a web
//! framework to the MVP. It is a single-user, one-request-per-connection
//! server; production hardening can replace the listener without changing the
//! runtime/service boundary.

use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};

use serde_json::{Value, json};
use work_memory_core::{BucketStatus, BucketType};
use work_memory_runtime::{
    CanonicalRuntime, RuntimeError, active_buckets, archive_execution_to_value, bucket_detail,
    query_memory, query_memory_with_plan, search_memory,
};
use work_memory_service::{CanonicalServiceError, MemoryQuery, StructuredFieldFilter, TimeRange};

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

/// HTTP server for the Rust MVP runtime.
pub struct Server<M> {
    runtime: CanonicalRuntime<M>,
}

impl<M> Server<M> {
    pub const fn new(runtime: CanonicalRuntime<M>) -> Self {
        Self { runtime }
    }

    pub fn runtime(&self) -> &CanonicalRuntime<M> {
        &self.runtime
    }

    pub fn runtime_mut(&mut self) -> &mut CanonicalRuntime<M> {
        &mut self.runtime
    }
}

impl<M> Server<M>
where
    M: work_memory_runtime::MemoryModel,
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
            ("GET", "/api/memory/query") => self.handle_memory_query(query),
            ("GET", path) if path.starts_with("/api/buckets/") => {
                self.handle_bucket_detail(&path["/api/buckets/".len()..])
            }
            ("POST", "/api/archive") => self.handle_archive(&request.body),
            ("POST", "/api/memory/query") => self.handle_memory_query_json(&request.body),
            ("POST", "/api/archive/append") => self.handle_confirmed_append(&request.body),
            ("POST", "/api/archive/create") => self.handle_confirmed_create(&request.body),
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

    fn handle_memory_query(&self, query: &str) -> HttpResponse {
        let params = query_params(query);
        let Some(search_query) = params.get("q").filter(|value| !value.trim().is_empty()) else {
            return HttpResponse::error(400, "query parameter q must not be empty");
        };
        let limit = match parse_limit(query) {
            Ok(limit) => limit,
            Err(error) => return HttpResponse::error(400, error),
        };
        match query_memory(self.runtime.service(), search_query, limit) {
            Ok(mut body) => {
                body["ok"] = json!(true);
                HttpResponse::json(200, body)
            }
            Err(error) => runtime_error_response(error),
        }
    }

    fn handle_memory_query_json(&self, body: &str) -> HttpResponse {
        let value = match parse_json_object(body) {
            Ok(value) => value,
            Err(error) => return HttpResponse::error(400, error),
        };
        let Some(query_text) = value.get("query").and_then(Value::as_str) else {
            return HttpResponse::error(400, "query must be a string");
        };
        if query_text.trim().is_empty() {
            return HttpResponse::error(400, "query must not be empty");
        }
        let limit = match parse_json_limit(&value) {
            Ok(limit) => limit,
            Err(error) => return HttpResponse::error(400, error),
        };
        let mut plan = match MemoryQuery::parse(query_text, limit) {
            Ok(plan) => plan,
            Err(error) => return runtime_error_response(query_runtime_error(error)),
        };

        let statuses = match parse_json_statuses(&value) {
            Ok(statuses) => statuses,
            Err(error) => return HttpResponse::error(400, error),
        };
        if !statuses.is_empty() {
            plan = plan.with_statuses(statuses);
        }

        let time_range = match parse_json_time_range(&value) {
            Ok(time_range) => time_range,
            Err(error) => return runtime_error_response(query_runtime_error(error)),
        };
        if let Some(time_range) = time_range {
            plan = plan.with_time_range(Some(time_range));
        }

        let filters = match parse_json_filters(&value) {
            Ok(filters) => filters,
            Err(error) => return runtime_error_response(query_runtime_error(error)),
        };
        plan = match plan.with_structured_filters(filters) {
            Ok(plan) => plan,
            Err(error) => return runtime_error_response(query_runtime_error(error)),
        };

        match query_memory_with_plan(self.runtime.service(), plan) {
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

    fn handle_archive(&mut self, body: &str) -> HttpResponse {
        let value = match parse_json_object(body) {
            Ok(value) => value,
            Err(error) => return HttpResponse::error(400, error),
        };
        let Some(text) = value.get("text").and_then(Value::as_str) else {
            return HttpResponse::error(400, "text must be a string");
        };
        match self
            .runtime
            .archive(text, optional_string(&value, "focus_bucket_id"))
        {
            Ok(execution) => match archive_execution_to_value(&execution) {
                Ok(mut body) => {
                    body["ok"] = json!(true);
                    HttpResponse::json(200, body)
                }
                Err(error) => runtime_error_response(error),
            },
            Err(error) => runtime_error_response(error),
        }
    }

    fn handle_confirmed_append(&mut self, body: &str) -> HttpResponse {
        let value = match parse_json_object(body) {
            Ok(value) => value,
            Err(error) => return HttpResponse::error(400, error),
        };
        if !value
            .get("confirmation_granted")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return runtime_error_response(RuntimeError::ConfirmationRequired);
        }
        let Some(bucket_id) = value.get("bucket_id").and_then(Value::as_str) else {
            return HttpResponse::error(400, "bucket_id must be a string");
        };
        let Some(text) = value.get("text").and_then(Value::as_str) else {
            return HttpResponse::error(400, "text must be a string");
        };
        match self.runtime.append_confirmed(
            bucket_id,
            text,
            optional_string(&value, "focus_bucket_id"),
        ) {
            Ok(execution) => match archive_execution_to_value(&execution) {
                Ok(mut body) => {
                    body["ok"] = json!(true);
                    HttpResponse::json(200, body)
                }
                Err(error) => runtime_error_response(error),
            },
            Err(error) => runtime_error_response(error),
        }
    }

    fn handle_confirmed_create(&mut self, body: &str) -> HttpResponse {
        let value = match parse_json_object(body) {
            Ok(value) => value,
            Err(error) => return HttpResponse::error(400, error),
        };
        if !value
            .get("confirmation_granted")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return runtime_error_response(RuntimeError::ConfirmationRequired);
        }
        let Some(title) = value.get("title").and_then(Value::as_str) else {
            return HttpResponse::error(400, "title must be a string");
        };
        let Some(bucket_type) = value.get("bucket_type").and_then(Value::as_str) else {
            return HttpResponse::error(400, "bucket_type must be a string");
        };
        let bucket_type = match parse_bucket_type(bucket_type) {
            Ok(bucket_type) => bucket_type,
            Err(error) => return HttpResponse::error(400, error),
        };
        let Some(text) = value.get("text").and_then(Value::as_str) else {
            return HttpResponse::error(400, "text must be a string");
        };
        match self.runtime.create_confirmed(
            title,
            bucket_type,
            text,
            optional_string(&value, "focus_bucket_id"),
        ) {
            Ok(execution) => match archive_execution_to_value(&execution) {
                Ok(mut body) => {
                    body["ok"] = json!(true);
                    HttpResponse::json(200, body)
                }
                Err(error) => runtime_error_response(error),
            },
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

/// Serve the Rust MVP runtime until the process is stopped.
pub fn serve<M>(address: impl ToSocketAddrs, mut server: Server<M>) -> io::Result<()>
where
    M: work_memory_runtime::MemoryModel,
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

fn handle_connection<M>(stream: &mut TcpStream, server: &mut Server<M>) -> io::Result<()>
where
    M: work_memory_runtime::MemoryModel,
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
        RuntimeError::Canonical(CanonicalServiceError::Query(_)) => 400,
        RuntimeError::Canonical(error) if error.store_error().is_some() => 500,
        RuntimeError::Canonical(_) | RuntimeError::Store(_) | RuntimeError::Model(_) => 500,
    };
    HttpResponse::error(status, error.to_string())
}

fn query_runtime_error(error: work_memory_service::MemoryQueryError) -> RuntimeError {
    RuntimeError::Canonical(CanonicalServiceError::from(error))
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

fn parse_json_limit(value: &Value) -> Result<usize, String> {
    let limit = value
        .get("limit")
        .map(|value| {
            value
                .as_u64()
                .ok_or_else(|| "limit must be a positive integer".to_owned())
                .and_then(|limit| {
                    usize::try_from(limit)
                        .map_err(|_| "limit must be a positive integer".to_owned())
                })
        })
        .transpose()?
        .unwrap_or(DEFAULT_LIST_LIMIT);
    if !(1..=MAX_LIST_LIMIT).contains(&limit) {
        return Err(format!("limit must be between 1 and {MAX_LIST_LIMIT}"));
    }
    Ok(limit)
}

fn parse_json_statuses(value: &Value) -> Result<Vec<BucketStatus>, String> {
    let Some(statuses) = value.get("statuses") else {
        return Ok(Vec::new());
    };
    let Some(statuses) = statuses.as_array() else {
        return Err("statuses must be an array of strings".to_owned());
    };
    statuses
        .iter()
        .map(|status| {
            let status = status
                .as_str()
                .ok_or_else(|| "statuses must contain only strings".to_owned())?;
            parse_bucket_status(status)
        })
        .collect()
}

fn parse_json_time_range(
    value: &Value,
) -> Result<Option<TimeRange>, work_memory_service::MemoryQueryError> {
    let start = value.get("start_at");
    let end = value.get("end_at");
    match (start, end) {
        (None, None) => Ok(None),
        (Some(start), Some(end)) => {
            let start = start.as_str().ok_or_else(|| {
                work_memory_service::MemoryQueryError::InvalidTimeRange(
                    "start_at must be a timestamp string".to_owned(),
                )
            })?;
            let end = end.as_str().ok_or_else(|| {
                work_memory_service::MemoryQueryError::InvalidTimeRange(
                    "end_at must be a timestamp string".to_owned(),
                )
            })?;
            TimeRange::from_strings(start, end, "自定义时间范围").map(Some)
        }
        _ => Err(work_memory_service::MemoryQueryError::InvalidTimeRange(
            "start_at and end_at must be provided together".to_owned(),
        )),
    }
}

fn parse_json_filters(
    value: &Value,
) -> Result<Vec<StructuredFieldFilter>, work_memory_service::MemoryQueryError> {
    let Some(filters) = value.get("filters") else {
        return Ok(Vec::new());
    };
    let Some(filters) = filters.as_array() else {
        return Err(
            work_memory_service::MemoryQueryError::InvalidStructuredFilter(
                "filters must be an array".to_owned(),
            ),
        );
    };
    filters
        .iter()
        .map(|filter| {
            let Some(object) = filter.as_object() else {
                return Err(
                    work_memory_service::MemoryQueryError::InvalidStructuredFilter(
                        "each filter must be an object".to_owned(),
                    ),
                );
            };
            let field = object.get("field").and_then(Value::as_str).ok_or_else(|| {
                work_memory_service::MemoryQueryError::InvalidStructuredFilter(
                    "filter.field must be a string".to_owned(),
                )
            })?;
            let value = object.get("value").and_then(Value::as_str).ok_or_else(|| {
                work_memory_service::MemoryQueryError::InvalidStructuredFilter(
                    "filter.value must be a string".to_owned(),
                )
            })?;
            StructuredFieldFilter::new(field, value)
        })
        .collect()
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
        "done" => Ok(BucketStatus::Done),
        "archived" => Ok(BucketStatus::Archived),
        _ => Err("status must be active, paused, done, or archived".to_owned()),
    }
}

fn parse_bucket_type(value: &str) -> Result<BucketType, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "idea" => Ok(BucketType::Idea),
        "task" => Ok(BucketType::Task),
        "incident" => Ok(BucketType::Incident),
        "experiment" => Ok(BucketType::Experiment),
        "decision" => Ok(BucketType::Decision),
        "meeting" => Ok(BucketType::Meeting),
        "knowledge" => Ok(BucketType::Knowledge),
        "draft" => Ok(BucketType::Draft),
        _ => Err(
            "bucket_type must be idea, task, incident, experiment, decision, meeting, knowledge, or draft"
                .to_owned(),
        ),
    }
}

fn percent_decode(value: &str) -> String {
    let mut bytes = Vec::with_capacity(value.len());
    let input = value.as_bytes();
    let mut index = 0;
    while index < input.len() {
        if input[index] == b'%'
            && index + 2 < input.len()
            && let (Some(high), Some(low)) = (hex(input[index + 1]), hex(input[index + 2]))
        {
            bytes.push(high << 4 | low);
            index += 3;
            continue;
        }
        bytes.push(if input[index] == b'+' {
            b' '
        } else {
            input[index]
        });
        index += 1;
    }
    String::from_utf8_lossy(&bytes).into_owned()
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

/// Small browser UI served from the same origin as the API.
pub const INDEX_HTML: &str = r#"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Rust Work Memory</title>
  <style>
    body{font-family:system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;background:#f7f7f5;color:#202124}
    main{display:grid;grid-template-columns:1.35fr 1fr;gap:1rem}section{background:white;border:1px solid #ddd;border-radius:12px;padding:1rem;margin-bottom:1rem}
    textarea{width:100%;min-height:130px;box-sizing:border-box}button{padding:.55rem .9rem;margin:.35rem .35rem 0 0;cursor:pointer}
    .bucket{padding:.65rem 0;border-bottom:1px solid #eee;font-size:.92rem;cursor:pointer}.bucket:hover{background:#fafafa}
    button.bucket{display:block;width:100%;margin:0;border:0;border-radius:0;background:transparent;text-align:left}
    .muted{color:#6b7280}.result{white-space:pre-wrap}.memory{padding:.4rem 0;border-bottom:1px solid #eee}
    .reason,.question,.confirmation,.candidate-card,.move-card{margin-top:.8rem;padding:.75rem;border-radius:8px;background:#f5f7fa}
    .question{background:#fff8e1;border:1px solid #f0d98c}.candidate-card{background:#f8fafc;border:1px solid #e5e7eb}
    .confirmation h3,.move-card h3{margin:.1rem 0 .4rem;font-size:1rem}.confirmation label,.move-card label{display:block;margin:.45rem 0}
    input,select{box-sizing:border-box;max-width:100%;padding:.45rem;border:1px solid #cbd5e1;border-radius:6px}
    .success{color:#166534}.warning{color:#92400e}.query-plan{padding:.65rem;background:#eef6ff;border:1px solid #cfe3ff;border-radius:8px}.query-bucket{margin-top:.8rem;padding:.65rem;border:1px solid #e5e7eb;border-radius:8px}.query-entry{padding:.55rem 0;border-bottom:1px solid #eee}.query-entry:last-child{border-bottom:0}.query-evidence{font-size:.9rem}
    @media(max-width:760px){main{display:block}}
  </style>
</head>
<body>
  <h1>Rust 工作记忆 MVP</h1>
  <main>
    <div>
      <section>
        <h2>记录</h2>
        <textarea id="input" placeholder="输入一条工作事实，例如：支付回调从 10:20 开始失败。"></textarea>
        <br><button id="archive">归档</button>
        <div id="result" class="result muted">等待输入…</div>
      </section>
      <section>
        <h2>语言查询</h2>
        <input id="memory-query" type="text" style="width:100%" placeholder="例如：查询接口 A 最近两周的压测结果">
        <br><button id="memory-query-button">查询</button>
        <div id="memory-query-result" class="result muted">输入自然语言查询，系统会解析实体、主题、时间范围和状态。</div>
      </section>
      <section>
        <h2>Bucket 详情</h2>
        <div id="detail" class="muted">点击右侧 Bucket 查看详情。</div>
      </section>
    </div>
    <section>
      <h2>活跃 Bucket</h2>
      <div id="buckets" class="muted">加载中…</div>
    </section>
  </main>
<script>
const input=document.querySelector('#input');
const result=document.querySelector('#result');
const buckets=document.querySelector('#buckets');
const detail=document.querySelector('#detail');
const memoryQueryInput=document.querySelector('#memory-query');
const memoryQueryButton=document.querySelector('#memory-query-button');
const memoryQueryResult=document.querySelector('#memory-query-result');
let activeBuckets=[];
let pendingArchive=null;

function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function jsonRequest(url, options){const response=await fetch(url, options);const data=await response.json();if(!response.ok)throw new Error(data.error||`HTTP ${response.status}`);return data;}
function activeBucket(bucketId){return activeBuckets.find(bucket=>bucket.id===bucketId);}
function bucketLabel(bucket){return bucket?`「${escapeHtml(bucket.title)}」`:'未命名 Bucket';}
function renderBucketSummary(bucket){return `<b>${bucketLabel(bucket)}</b><br><span class="muted">${escapeHtml(bucket.type||'unknown')} · ${escapeHtml(bucket.status||'')}</span><p>${escapeHtml(bucket.summary||'暂无摘要')}</p>`;}
function renderBucketOptions(excludeId){
  const options=activeBuckets.filter(bucket=>bucket.id!==excludeId);
  if(!options.length)return '<option value="">暂无其他活跃 Bucket</option>';
  return options.map(bucket=>`<option value="${escapeHtml(bucket.id)}">${escapeHtml(bucket.title)} · ${escapeHtml(bucket.type||'unknown')}</option>`).join('');
}
function candidateBuckets(data){
  const supplied=new Map((data.candidate_buckets||[]).filter(bucket=>bucket&&bucket.id).map(bucket=>[bucket.id,bucket]));
  const ordered=[];
  for(const bucketId of (data.candidate_bucket_ids||[])){
    const bucket=supplied.get(bucketId)||activeBucket(bucketId);
    if(bucket&&!ordered.some(item=>item.id===bucket.id))ordered.push(bucket);
  }
  for(const bucket of (data.candidate_buckets||[])){
    if(bucket&&bucket.id&&!ordered.some(item=>item.id===bucket.id))ordered.push(bucket);
  }
  return ordered;
}
async function refresh(){
  try{
    const data=await jsonRequest('/api/buckets/active');
    activeBuckets=data.buckets||[];
    buckets.innerHTML=activeBuckets.map(bucket=>`<button class="bucket" data-action="show-bucket" data-bucket-id="${escapeHtml(bucket.id)}">${renderBucketSummary(bucket)}</button>`).join('')||'暂无活跃 Bucket';
  }catch(error){buckets.textContent=error.message;}
}
async function showBucket(bucketId){
  try{
    const data=await jsonRequest('/api/buckets/'+encodeURIComponent(bucketId));
    const bucket=data.detail.bucket;
    detail.innerHTML=renderBucketSummary(bucket)+(data.detail.entries||[]).map(entry=>`<div class="memory"><b>Entry</b><br>${escapeHtml(entry.raw_text)}<br><span class="muted">${escapeHtml(entry.summary||'')}</span></div>`).join('');
  }catch(error){detail.textContent=error.message;}
}
function renderMoveCard(data){
  if(!data.entry_id)return '';
  const targetOptions=renderBucketOptions(data.bucket_id);
  const hasTarget=activeBuckets.some(bucket=>bucket.id!==data.bucket_id);
  return `<div class="move-card"><h3>修改 Bucket</h3>${hasTarget?`<label>将这条 Entry 移动到：<select id="move-target">${targetOptions}</select></label><button data-action="move-entry" data-entry-id="${escapeHtml(data.entry_id)}">修改 Bucket</button>`:'<span class="muted">暂无其他活跃 Bucket 可供移动。</span>'}<div id="move-status" class="muted"></div></div>`;
}
function renderQueryPlan(plan){
  const range=plan.time_range?`${escapeHtml(plan.time_range.label)}（${escapeHtml(plan.time_range.start)} 至 ${escapeHtml(plan.time_range.end)}）`:'未指定';
  const statuses=(plan.statuses||[]).map(escapeHtml).join('、')||'未指定';
  const filters=(plan.structured_filters||[]).map(filter=>`${escapeHtml(filter.field)}=${escapeHtml(filter.value)}`).join('；')||'无';
  return `<div class="query-plan"><b>查询理解</b><br>实体：${(plan.entity_terms||[]).map(escapeHtml).join('、')||'未识别'}<br>主题：${(plan.topic_terms||[]).map(escapeHtml).join('、')||'未识别'}<br>时间范围：${range}<br>状态：${statuses}<br>结构化筛选：${filters}</div>`;
}
function renderMemoryQuery(data){
  let html=renderQueryPlan(data.query_plan||{});
  html+=`<p><b>合并回答：</b>${escapeHtml(data.answer||'')}</p>`;
  const results=data.results||[];
  if(!results.length){memoryQueryResult.innerHTML=html+'<p class="muted">没有匹配的 Entry。</p>';return;}
  const groups=new Map();
  for(const hit of results){
    const id=hit.bucket?.id||'unknown';
    if(!groups.has(id))groups.set(id,{bucket:hit.bucket,entries:[]});
    groups.get(id).entries.push(hit);
  }
  html+='<h3>按 Bucket 合并的证据</h3>';
  for(const group of groups.values()){
    html+=`<div class="query-bucket"><b>${bucketLabel(group.bucket)}</b> <span class="muted">${escapeHtml(group.bucket?.status||'')} · ${group.entries.length} 条 Entry</span>`;
    for(const hit of group.entries){
      const entry=hit.entry||{};
      html+=`<div class="query-entry"><b>Entry</b> · ${escapeHtml(entry.created_at||'')} · score ${escapeHtml(hit.score)}<br>${escapeHtml(entry.raw_text||'')}<br><span class="muted">${escapeHtml(entry.summary||'')}</span><br><span class="muted">匹配字段：${(hit.matched_fields||[]).map(escapeHtml).join('、')||'关键词/语义匹配'}</span></div>`;
    }
    html+='</div>';
  }
  const evidence=data.evidence||[];
  if(evidence.length){html+='<div class="query-evidence"><h3>去重后的证据</h3>'+evidence.map(memory=>`<div class="memory"><b>${escapeHtml(memory.kind||'evidence')}</b>：${escapeHtml(memory.text||'')}</div>`).join('')+'</div>';}
  memoryQueryResult.innerHTML=html;
}
async function runMemoryQuery(){
  const query=memoryQueryInput.value.trim();
  if(!query){memoryQueryResult.textContent='请输入自然语言查询。';return;}
  memoryQueryResult.textContent='查询中…';
  try{const data=await jsonRequest('/api/memory/query?q='+encodeURIComponent(query)+'&limit=20');renderMemoryQuery(data);}
  catch(error){memoryQueryResult.textContent=error.message;}
}
function showArchive(data){
  result.className='result';
  let html=`<b>${escapeHtml(data.archive_state)}</b> · ${escapeHtml(data.action)} · confidence ${escapeHtml(data.confidence)}<div class="reason"><b>模型判断理由：</b>${escapeHtml(data.reason||'未提供理由。')}</div>`;
  if(data.archive_state==='needs_confirmation'){
    const candidates=candidateBuckets(data);
    const recommendedId=data.recommended_bucket_id||data.recommended_bucket?.id||candidates[0]?.id||'';
    const recommended=data.recommended_bucket||candidates.find(bucket=>bucket.id===recommendedId)||activeBucket(recommendedId);
    html+=`<div class="question"><b>请确认：</b>${escapeHtml(data.question||'信息不够明确，请选择归档方式。')}</div>`;
    html+='<div class="confirmation"><h3>推荐 Bucket</h3>';
    if(recommended){
      html+=`<div class="candidate-card">${renderBucketSummary(recommended)}</div><button data-action="confirm-append" data-bucket-id="${escapeHtml(recommended.id)}">1. 保存到${bucketLabel(recommended)}</button>`;
    }else{
      html+='<p class="muted">模型没有给出可直接确认的已有 Bucket。</p>';
    }
    const alternatives=candidates.filter(bucket=>bucket.id!==recommendedId);
    html+='<h3>备选 Bucket</h3>';
    html+=alternatives.length?alternatives.map(bucket=>`<div class="candidate-card">${renderBucketSummary(bucket)}</div>`).join(''):'<p class="muted">模型没有给出其他明确候选，可从全部活跃 Bucket 中选择。</p>';
    html+=`<label>保存到其他 Bucket：<select id="alternative-bucket">${renderBucketOptions(recommendedId)}</select></label><button data-action="confirm-alternative">2. 保存到其他 Bucket</button>`;
    html+='</div>';
    html+=`<div class="confirmation"><h3>创建新 Bucket</h3><label>标题：<input id="new-bucket-title" value="${escapeHtml(data.bucket_title||'')}" placeholder="例如：接口 A 压测"></label><label>类型：<select id="new-bucket-type">${['task','incident','experiment','idea','decision','meeting','knowledge','draft'].map(type=>`<option value="${type}"${type===(data.bucket_type||'task')?' selected':''}>${type}</option>`).join('')}</select></label><button data-action="confirm-create">3. 创建新的 Bucket</button></div>`;
    html+='<button data-action="discard">4. 不保存</button>';
  }else if(data.archive_state==='archived'){
    if(data.bucket)html+=`<div class="confirmation success"><b>已归档到：</b>${bucketLabel(data.bucket)}</div>`;
    if(data.extraction)html+=`<br>摘要：${escapeHtml(data.extraction.summary)}`;
    html+=renderMoveCard(data);
  }
  result.innerHTML=html;
}
async function archive(){
  const text=input.value.trim();
  if(!text)return;
  pendingArchive=null;
  result.textContent='归档中…';
  try{
    const data=await jsonRequest('/api/archive',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});
    await refresh();
    if(data.archive_state==='needs_confirmation'){
      pendingArchive={text,data};
      input.value=text;
      showArchive(data);
    }else{
      input.value='';
      showArchive(data);
      if(data.bucket_id)showBucket(data.bucket_id);
    }
  }catch(error){result.textContent=error.message;}
}
function pendingText(){if(!pendingArchive)throw new Error('没有待确认的归档内容');return pendingArchive.text;}
async function confirmAppend(bucketId){
  const text=pendingText();
  const data=await jsonRequest('/api/archive/append',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bucket_id:bucketId,text,confirmation_granted:true})});
  pendingArchive=null;input.value='';await refresh();showArchive(data);if(data.bucket_id)showBucket(data.bucket_id);
}
async function confirmCreate(){
  const text=pendingText();
  const title=document.querySelector('#new-bucket-title')?.value.trim();
  const bucketType=document.querySelector('#new-bucket-type')?.value;
  if(!title)throw new Error('新 Bucket 标题不能为空');
  const data=await jsonRequest('/api/archive/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,bucket_type:bucketType,text,confirmation_granted:true})});
  pendingArchive=null;input.value='';await refresh();showArchive(data);if(data.bucket_id)showBucket(data.bucket_id);
}
function discardPending(){pendingArchive=null;input.value='';result.className='result';result.innerHTML='<b>不保存</b><br><span class="muted">本次没有创建正式 Entry；分类审计已保留。</span>';}
async function moveEntry(entryId){
  const targetBucketId=document.querySelector('#move-target')?.value;
  if(!targetBucketId)throw new Error('请选择目标 Bucket');
  const data=await jsonRequest('/api/corrections/move',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({entry_id:entryId,target_bucket_id:targetBucketId,command_text:'用户在归档后修改了 Bucket。'})});
  const status=document.querySelector('#move-status');
  if(status)status.innerHTML=`<span class="success">已移动到${bucketLabel(activeBucket(targetBucketId)||{title:targetBucketId})}。</span>`;
  await refresh();showBucket(targetBucketId);
}
result.addEventListener('click',async event=>{
  const button=event.target.closest('button[data-action]');
  if(!button)return;
  const action=button.dataset.action;
  try{
    button.disabled=true;
    if(action==='confirm-append')await confirmAppend(button.dataset.bucketId);
    else if(action==='confirm-alternative'){
      const target=document.querySelector('#alternative-bucket')?.value;
      if(!target)throw new Error('请选择其他 Bucket');
      await confirmAppend(target);
    }else if(action==='confirm-create')await confirmCreate();
    else if(action==='discard')discardPending();
    else if(action==='move-entry')await moveEntry(button.dataset.entryId);
  }catch(error){result.insertAdjacentHTML('beforeend',`<div class="warning">${escapeHtml(error.message)}</div>`);}finally{button.disabled=false;}
});
buckets.addEventListener('click',event=>{const button=event.target.closest('button[data-action="show-bucket"]');if(button)showBucket(button.dataset.bucketId);});
document.querySelector('#archive').addEventListener('click',archive);
memoryQueryButton.addEventListener('click',runMemoryQuery);
memoryQueryInput.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();runMemoryQuery();}});
refresh();
</script>
</body></html>"#;

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use serde_json::{Value, json};
    use tempfile::tempdir;
    use work_memory_core::{BucketType, ClassificationResult, ConfidencePolicy, ExtractionResult};
    use work_memory_runtime::{CanonicalRuntime, MemoryModel, RuntimeError};
    use work_memory_service::{CanonicalService, CanonicalServiceError};
    use work_memory_store::StoreError;

    use super::{HttpRequest, Server, runtime_error_response};

    struct Model {
        classifications: VecDeque<Result<ClassificationResult, String>>,
        extractions: VecDeque<Result<ExtractionResult, String>>,
    }

    impl Model {
        fn new(
            classifications: impl IntoIterator<Item = Result<ClassificationResult, String>>,
            extractions: impl IntoIterator<Item = Result<ExtractionResult, String>>,
        ) -> Self {
            Self {
                classifications: classifications.into_iter().collect(),
                extractions: extractions.into_iter().collect(),
            }
        }
    }

    impl MemoryModel for Model {
        type Error = String;

        fn classify(
            &mut self,
            _text: &str,
            _candidates: &[work_memory_core::BucketView],
        ) -> Result<ClassificationResult, Self::Error> {
            self.classifications
                .pop_front()
                .expect("server classification fixture")
        }

        fn extract(&mut self, _text: &str) -> Result<ExtractionResult, Self::Error> {
            self.extractions
                .pop_front()
                .expect("server extraction fixture")
        }
    }

    fn server_with_queues(
        classifications: impl IntoIterator<Item = Result<ClassificationResult, String>>,
        extractions: impl IntoIterator<Item = Result<ExtractionResult, String>>,
    ) -> (Server<Model>, tempfile::TempDir) {
        let database = tempdir().expect("tempdir");
        let service =
            CanonicalService::initialize(database.path().join("memory.db")).expect("service");
        let runtime = CanonicalRuntime::new(
            service,
            Model::new(classifications, extractions),
            ConfidencePolicy::default(),
            "fixture-model",
            "server-test-v1",
        )
        .expect("runtime");
        (Server::new(runtime), database)
    }

    fn server() -> (Server<Model>, tempfile::TempDir) {
        let classification = ClassificationResult::create_new(
            BucketType::Task,
            "Rust MVP",
            0.99,
            "new task",
            vec![],
        )
        .expect("classification");
        server_with_queues(
            [Ok(classification)],
            [
                Ok(ExtractionResult::minimal("stored summary").expect("extraction")),
                Ok(ExtractionResult::minimal("confirmed append summary").expect("extraction")),
                Ok(ExtractionResult::minimal("confirmed create summary").expect("extraction")),
            ],
        )
    }

    #[test]
    fn health_and_static_ui_routes_are_available() {
        let (mut server, _database) = server();
        let health = server.handle_request(HttpRequest::new("GET", "/health", ""));
        assert_eq!(health.status, 200);
        assert!(health.body.contains("work-memory-server"));
        let ui = server.handle_request(HttpRequest::new("GET", "/", ""));
        assert_eq!(ui.content_type, "text/html; charset=utf-8");
        assert!(ui.body.contains("Rust 工作记忆 MVP"));
        assert!(ui.body.contains("/api/archive"));
        for marker in [
            "推荐 Bucket",
            "备选 Bucket",
            "模型判断理由",
            "创建新 Bucket",
            "不保存",
            "修改 Bucket",
            "recommended_bucket",
            "candidate_buckets",
            "recommended_bucket_id",
            "candidate_bucket_ids",
            "entry_id",
            "语言查询",
            "/api/memory/query",
            "query_plan",
            "entity_terms",
            "topic_terms",
            "matched_fields",
            "去重后的证据",
            "合并回答",
            "/api/archive/append",
            "/api/archive/create",
            "/api/corrections/move",
        ] {
            assert!(ui.body.contains(marker), "missing UI marker: {marker}");
        }
        assert!(!ui.body.contains("onclick="));
        assert!(!ui.body.contains("candidate_bucket_ids[0]"));
    }

    #[test]
    fn archive_route_runs_the_mvp_loop_and_returns_result() {
        let (mut server, _database) = server();
        let response = server.handle_request(HttpRequest::new(
            "POST",
            "/api/archive",
            r#"{"text":"The Rust MVP is working."}"#,
        ));
        assert_eq!(response.status, 200, "{}", response.body);
        let body: Value = serde_json::from_str(&response.body).expect("archive JSON");
        assert_eq!(body["ok"], true);
        assert_eq!(body["archive_state"], "archived");
        assert!(body["bucket_id"].is_string());
        assert!(body["entry_id"].is_string());
        assert_eq!(body["bucket_title"], "Rust MVP");
        assert_eq!(body["bucket_type"], "task");
        assert_eq!(body["extraction"]["summary"], "stored summary");
    }

    #[test]
    fn encoded_utf8_natural_language_query_is_decoded_before_search() {
        let (mut server, _database) = server();
        let archive = server.handle_request(HttpRequest::new(
            "POST",
            "/api/archive",
            r#"{"text":"接口 A 压测结果已完成，P99 为 120ms，持续 10 分钟。"}"#,
        ));
        assert_eq!(archive.status, 200, "{}", archive.body);

        let response = server.handle_request(HttpRequest::new(
            "GET",
            "/api/memory/query?q=%E6%8E%A5%E5%8F%A3%20A%20%E5%8E%8B%E6%B5%8B%E7%BB%93%E6%9E%9C&limit=10",
            "",
        ));
        assert_eq!(response.status, 200, "{}", response.body);
        let body: Value = serde_json::from_str(&response.body).expect("query JSON");
        assert_eq!(body["total_entries"], 1, "{}", response.body);
        assert_eq!(
            body["results"][0]["entry"]["raw_text"],
            "接口 A 压测结果已完成，P99 为 120ms，持续 10 分钟。"
        );
        assert_eq!(body["query_plan"]["entity_terms"], json!(["接口 A"]));
    }

    #[test]
    fn natural_language_query_routes_return_entry_results_and_query_plan() {
        let (mut server, _database) = server();
        let archive = server.handle_request(HttpRequest::new(
            "POST",
            "/api/archive",
            r#"{"text":"The Rust MVP is working."}"#,
        ));
        assert_eq!(archive.status, 200, "{}", archive.body);

        let get = server.handle_request(HttpRequest::new(
            "GET",
            "/api/memory/query?q=Rust%20MVP&limit=10",
            "",
        ));
        assert_eq!(get.status, 200, "{}", get.body);
        let get_body: Value = serde_json::from_str(&get.body).expect("query JSON");
        assert_eq!(get_body["ok"], true);
        assert_eq!(get_body["total_entries"], 1);
        assert_eq!(get_body["total_buckets"], 1);
        assert_eq!(
            get_body["results"][0]["entry"]["raw_text"],
            "The Rust MVP is working."
        );
        assert_eq!(
            get_body["query_plan"]["entity_terms"]
                .as_array()
                .unwrap()
                .len(),
            0
        );

        let post = server.handle_request(HttpRequest::new(
            "POST",
            "/api/memory/query",
            r#"{"query":"Rust","limit":10,"statuses":["active"],"filters":[{"field":"status","value":"active"}]}"#,
        ));
        assert_eq!(post.status, 200, "{}", post.body);
        let post_body: Value = serde_json::from_str(&post.body).expect("query POST JSON");
        assert_eq!(post_body["total_entries"], 1);
        assert_eq!(post_body["query_plan"]["statuses"], json!(["active"]));
        assert_eq!(
            post_body["query_plan"]["structured_filters"][0]["field"],
            "status"
        );
    }

    #[test]
    fn confirmation_response_projects_recommended_and_candidate_buckets() {
        let first = ClassificationResult::create_new(
            BucketType::Task,
            "接口 A 压测",
            0.99,
            "明确的新任务。",
            vec![],
        )
        .expect("first classification");
        let second = ClassificationResult::create_new(
            BucketType::Incident,
            "支付回调故障",
            0.99,
            "明确的新故障。",
            vec![],
        )
        .expect("second classification");
        let ask = ClassificationResult::ask_user(
            None,
            None,
            0.99,
            "输入缺少可核验事实。",
            "请选择归档目标。",
            vec![],
        )
        .expect("ask classification");
        let (mut server, _database) = server_with_queues(
            [Ok(first), Ok(second), Ok(ask)],
            [
                Ok(ExtractionResult::minimal("first").expect("extraction")),
                Ok(ExtractionResult::minimal("second").expect("extraction")),
            ],
        );

        for text in ["第一条事实", "第二条事实"] {
            let response = server.handle_request(HttpRequest::new(
                "POST",
                "/api/archive",
                format!(r#"{{"text":"{text}"}}"#),
            ));
            assert_eq!(response.status, 200, "{}", response.body);
            let body: Value = serde_json::from_str(&response.body).expect("seed JSON");
            assert_eq!(body["archive_state"], "archived");
        }

        let response = server.handle_request(HttpRequest::new(
            "POST",
            "/api/archive",
            r#"{"text":"压测结果更新了"}"#,
        ));
        assert_eq!(response.status, 200, "{}", response.body);
        let body: Value = serde_json::from_str(&response.body).expect("confirmation JSON");
        assert_eq!(body["archive_state"], "needs_confirmation");
        assert_eq!(body["action"], "ask_user");
        assert!(body["reason"].is_string());
        assert!(body["question"].is_string());
        assert!(body["recommended_bucket_id"].is_string());
        assert!(body["recommended_bucket"].is_object());
        assert_eq!(
            body["recommended_bucket"]["id"],
            body["recommended_bucket_id"]
        );
        let candidates = body["candidate_buckets"].as_array().expect("candidates");
        let candidate_ids = body["candidate_bucket_ids"]
            .as_array()
            .expect("candidate ids");
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidate_ids.len(), 2);
        assert_eq!(
            candidates
                .iter()
                .filter(|candidate| candidate["is_recommended"] == true)
                .count(),
            1
        );
        for candidate in candidates {
            for field in ["id", "title", "type", "status", "summary", "is_recommended"] {
                assert!(
                    !candidate[field].is_null(),
                    "missing candidate field: {field}"
                );
            }
        }
        assert!(body["bucket_title"].is_null());
        assert!(body["bucket_type"].is_null());
    }

    #[test]
    fn confirmed_archive_routes_write_and_return_entries() {
        let (mut server, _database) = server();
        let initial = server.handle_request(HttpRequest::new(
            "POST",
            "/api/archive",
            r#"{"text":"The Rust MVP is working."}"#,
        ));
        assert_eq!(initial.status, 200, "{}", initial.body);
        let initial_body: Value = serde_json::from_str(&initial.body).expect("initial JSON");
        let bucket_id = initial_body["bucket_id"]
            .as_str()
            .expect("initial bucket id")
            .to_owned();

        let append = server.handle_request(HttpRequest::new(
            "POST",
            "/api/archive/append",
            format!(
                r#"{{"bucket_id":"{bucket_id}","text":"An explicitly confirmed append.","confirmation_granted":true}}"#
            ),
        ));
        assert_eq!(append.status, 200, "{}", append.body);
        let append_body: Value = serde_json::from_str(&append.body).expect("append JSON");
        assert_eq!(append_body["archive_state"], "archived");
        assert_eq!(append_body["bucket_id"], bucket_id);
        assert!(append_body["entry_id"].is_string());
        assert_eq!(
            append_body["extraction"]["summary"],
            "confirmed append summary"
        );

        let create = server.handle_request(HttpRequest::new(
            "POST",
            "/api/archive/create",
            r#"{"title":"Confirmed bucket","bucket_type":"incident","text":"A separately confirmed entry.","confirmation_granted":true}"#,
        ));
        assert_eq!(create.status, 200, "{}", create.body);
        let create_body: Value = serde_json::from_str(&create.body).expect("create JSON");
        assert_eq!(create_body["archive_state"], "archived");
        assert_eq!(create_body["bucket_title"], "Confirmed bucket");
        assert_eq!(create_body["bucket_type"], "incident");
        assert!(create_body["bucket_id"].is_string());
        assert!(create_body["entry_id"].is_string());
        assert_eq!(
            create_body["extraction"]["summary"],
            "confirmed create summary"
        );

        let entry_id = initial_body["entry_id"].as_str().expect("initial entry id");
        let target_bucket_id = create_body["bucket_id"].as_str().expect("target bucket id");
        let move_response = server.handle_request(HttpRequest::new(
            "POST",
            "/api/corrections/move",
            format!(
                r#"{{"entry_id":"{entry_id}","target_bucket_id":"{target_bucket_id}","command_text":"用户修改了 Bucket。"}}"#
            ),
        ));
        assert_eq!(move_response.status, 200, "{}", move_response.body);
        let move_body: Value = serde_json::from_str(&move_response.body).expect("move JSON");
        assert_eq!(move_body["entry"]["id"], entry_id);
        assert_eq!(move_body["entry"]["bucket_id"], target_bucket_id);
        assert_eq!(move_body["entry"]["moved_from_bucket_id"], bucket_id);
    }

    #[test]
    fn invalid_requests_and_confirmation_routes_are_rejected() {
        let (mut server, _database) = server();
        let search = server.handle_request(HttpRequest::new("GET", "/api/buckets/search", ""));
        assert_eq!(search.status, 400);
        let archive = server.handle_request(HttpRequest::new("POST", "/api/archive", "{}"));
        assert_eq!(archive.status, 400);
        let append = server.handle_request(HttpRequest::new(
            "POST",
            "/api/archive/append",
            r#"{"bucket_id":"missing","text":"write"}"#,
        ));
        assert_eq!(append.status, 400);
        assert!(append.body.contains("confirmation"));

        let empty_query =
            server.handle_request(HttpRequest::new("GET", "/api/memory/query?q=&limit=10", ""));
        assert_eq!(empty_query.status, 400);
        let invalid_date = server.handle_request(HttpRequest::new(
            "POST",
            "/api/memory/query",
            r#"{"query":"Rust","start_at":"not-a-date","end_at":"2026-08-06"}"#,
        ));
        assert_eq!(invalid_date.status, 400);
    }

    #[test]
    fn read_routes_and_store_failures_have_stable_json_errors() {
        let (mut server, _database) = server();
        let active =
            server.handle_request(HttpRequest::new("GET", "/api/buckets/active?limit=1", ""));
        assert_eq!(active.status, 200);
        let active_body: Value = serde_json::from_str(&active.body).expect("active JSON");
        assert_eq!(active_body["ok"], true);
        assert!(active_body["buckets"].is_array());

        let detail = server.handle_request(HttpRequest::new("GET", "/api/buckets/missing", ""));
        assert_eq!(detail.status, 404);
        let invalid_status = server.handle_request(HttpRequest::new(
            "POST",
            "/api/buckets/status",
            r#"{"bucket_id":"missing","status":"unknown"}"#,
        ));
        assert_eq!(invalid_status.status, 400);
        let response = runtime_error_response(RuntimeError::Canonical(
            CanonicalServiceError::Store(StoreError::InvalidLimit(0)),
        ));
        assert_eq!(response.status, 500);
    }
}
