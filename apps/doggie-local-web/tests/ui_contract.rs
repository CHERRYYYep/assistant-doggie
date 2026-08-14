use doggie_local_web::{APP_JS, INDEX_HTML, STYLES_CSS};

fn ui_bundle() -> String {
    format!("{INDEX_HTML}{STYLES_CSS}{APP_JS}")
}

#[test]
fn static_frontend_uses_external_assets() {
    assert!(INDEX_HTML.contains("assets/styles.css"));
    assert!(INDEX_HTML.contains("assets/app.js"));
    assert!(!INDEX_HTML.contains("<style>"));
    assert!(!INDEX_HTML.contains("<script>"));
    assert!(STYLES_CSS.contains(".app-shell"));
    assert!(APP_JS.contains("async function sendMessage"));
}

#[test]
fn static_frontend_exposes_one_safe_markdown_renderer() {
    for marker in [
        "function escapeHtml",
        "function safeHref",
        "function renderInline",
        "function renderCodeBlock",
        "function renderMarkdown",
        "md-code-block",
        "md-code-header",
        "<pre><code${className}>",
        "language-${escapeHtml(language)}",
        "renderMarkdown(data.answer||'')",
        "target=\"_blank\" rel=\"noreferrer noopener\"",
    ] {
        assert!(
            APP_JS.contains(marker),
            "missing UI renderer marker: {marker}"
        );
    }

    assert_eq!(
        APP_JS.matches("function renderMarkdown(").count(),
        1,
        "the frontend renderer must not be shadowed by a second declaration"
    );
    assert!(!APP_JS.contains("return renderMarkdown(value);"));
    assert!(!APP_JS.contains("innerHTML=message.content"));
    assert!(!APP_JS.contains("innerHTML=data.answer"));
}

#[test]
fn static_frontend_keeps_markdown_inputs_and_links_escaped() {
    for marker in [
        "escapeHtml(lines.join('\\n'))",
        "escapeHtml(plain)",
        "escapeHtml(href)",
        "escapeHtml(link[3])",
        "if(/[\\u0000-\\u001f\\u007f]/.test(href))return '';",
    ] {
        assert!(APP_JS.contains(marker), "missing escaping guard: {marker}");
    }

    assert!(APP_JS.contains("rel=\"noreferrer noopener\""));
    assert!(!APP_JS.contains("href=\"${link[2]}\""));
}

#[test]
fn static_frontend_exposes_auto_bucket_association_and_delete_controls() {
    let bundle = ui_bundle();
    for marker in [
        "自动关联最近和热门 Bucket",
        "删除 Bucket",
        "data-action=\"delete-bucket\"",
        "async function deleteBucket",
        "method:'DELETE'",
        "'/api/buckets/'+encodeURIComponent(bucketId)",
        "body:JSON.stringify({message:text})",
    ] {
        assert!(
            bundle.contains(marker),
            "missing bucket delete/auto-association marker: {marker}"
        );
    }
    assert!(!APP_JS.contains("focus_bucket_id:selectedBucketId"));
}
