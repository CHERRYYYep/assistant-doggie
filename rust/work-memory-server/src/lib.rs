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
    search_memory,
};

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
            ("GET", path) if path.starts_with("/api/buckets/") => {
                self.handle_bucket_detail(&path["/api/buckets/".len()..])
            }
            ("POST", "/api/archive") => self.handle_archive(&request.body),
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
        RuntimeError::Canonical(error) if error.store_error().is_some() => 500,
        RuntimeError::Canonical(_) | RuntimeError::Store(_) | RuntimeError::Model(_) => 500,
    };
    HttpResponse::error(status, error.to_string())
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
    .muted{color:#6b7280}.result{white-space:pre-wrap}.memory{padding:.4rem 0;border-bottom:1px solid #eee}
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
const input=document.querySelector('#input'), result=document.querySelector('#result'), buckets=document.querySelector('#buckets'), detail=document.querySelector('#detail');
function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function jsonRequest(url, options){const r=await fetch(url, options);const d=await r.json();if(!r.ok)throw new Error(d.error||`HTTP ${r.status}`);return d;}
async function refresh(){try{const d=await jsonRequest('/api/buckets/active');buckets.innerHTML=(d.buckets||[]).map(b=>`<div class="bucket" onclick="showBucket('${encodeURIComponent(b.id)}')"><b>${escapeHtml(b.title)}</b><br><span class="muted">${escapeHtml(b.type)} · ${escapeHtml(b.summary||'')}</span></div>`).join('')||'暂无活跃 Bucket';}catch(e){buckets.textContent=e.message;}}
async function showBucket(encoded){try{const d=await jsonRequest('/api/buckets/'+encoded);const b=d.detail.bucket;detail.innerHTML=`<b>${escapeHtml(b.title)}</b><br><span class="muted">${escapeHtml(b.type)} · ${escapeHtml(b.status)}</span><p>${escapeHtml(b.summary||'')}</p>`+(d.detail.entries||[]).map(e=>`<div class="memory"><b>Entry</b><br>${escapeHtml(e.raw_text)}<br><span class="muted">${escapeHtml(e.summary||'')}</span></div>`).join('');}catch(e){detail.textContent=e.message;}}
function showArchive(d,text){result.className='result';let html=`<b>${escapeHtml(d.archive_state)}</b> · ${escapeHtml(d.action)} · confidence ${escapeHtml(d.confidence)}<br>${escapeHtml(d.reason||'')}`;if(d.bucket)html+=`<br><br>已归档到：<b>${escapeHtml(d.bucket.title)}</b>`;if(d.extraction)html+=`<br>摘要：${escapeHtml(d.extraction.summary)}`;if(d.archive_state==='needs_confirmation'){html+=`<br><br>${escapeHtml(d.question||'需要确认归档目标。')}`;if((d.candidate_bucket_ids||[]).length){html+=`<br><button onclick="confirmAppend('${encodeURIComponent(d.candidate_bucket_ids[0])}',${JSON.stringify(text)})">确认追加到候选 Bucket</button>`;}if(d.bucket_title&&d.bucket_type){html+=`<button onclick="confirmCreate(${JSON.stringify(d.bucket_title)},${JSON.stringify(d.bucket_type)},${JSON.stringify(text)})">确认新建 Bucket</button>`;}}result.innerHTML=html;}
async function archive(){const text=input.value.trim();if(!text)return;result.textContent='归档中…';try{const d=await jsonRequest('/api/archive',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});showArchive(d,text);input.value='';await refresh();if(d.bucket_id)showBucket(encodeURIComponent(d.bucket_id));}catch(e){result.textContent=e.message;}}
async function confirmAppend(bucketId,text){try{const d=await jsonRequest('/api/archive/append',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bucket_id:decodeURIComponent(bucketId),text,confirmation_granted:true})});showArchive(d,text);await refresh();if(d.bucket_id)showBucket(encodeURIComponent(d.bucket_id));}catch(e){result.textContent=e.message;}}
async function confirmCreate(title,bucketType,text){try{const d=await jsonRequest('/api/archive/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,bucket_type:bucketType,text,confirmation_granted:true})});showArchive(d,text);await refresh();if(d.bucket_id)showBucket(encodeURIComponent(d.bucket_id));}catch(e){result.textContent=e.message;}}
document.querySelector('#archive').onclick=archive;refresh();
</script>
</body></html>"#;

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use serde_json::Value;
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

    fn server() -> (Server<Model>, tempfile::TempDir) {
        let database = tempdir().expect("tempdir");
        let service =
            CanonicalService::initialize(database.path().join("memory.db")).expect("service");
        let classification = ClassificationResult::create_new(
            BucketType::Task,
            "Rust MVP",
            0.99,
            "new task",
            vec![],
        )
        .expect("classification");
        let extraction = ExtractionResult::minimal("stored summary").expect("extraction");
        let confirmed_append_extraction =
            ExtractionResult::minimal("confirmed append summary").expect("extraction");
        let confirmed_create_extraction =
            ExtractionResult::minimal("confirmed create summary").expect("extraction");
        let runtime = CanonicalRuntime::new(
            service,
            Model::new(
                [Ok(classification)],
                [
                    Ok(extraction),
                    Ok(confirmed_append_extraction),
                    Ok(confirmed_create_extraction),
                ],
            ),
            ConfidencePolicy::default(),
            "fixture-model",
            "server-test-v1",
        )
        .expect("runtime");
        (Server::new(runtime), database)
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
