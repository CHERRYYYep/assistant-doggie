use work_memory_server::INDEX_HTML;

#[test]
fn embedded_ui_exposes_one_safe_markdown_renderer() {
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
            INDEX_HTML.contains(marker),
            "missing UI renderer marker: {marker}"
        );
    }

    assert_eq!(
        INDEX_HTML.matches("function renderMarkdown(").count(),
        1,
        "the embedded renderer must not be shadowed by a second declaration"
    );
    assert!(!INDEX_HTML.contains("return renderMarkdown(value);"));
    assert!(!INDEX_HTML.contains("innerHTML=message.content"));
    assert!(!INDEX_HTML.contains("innerHTML=data.answer"));
}

#[test]
fn embedded_ui_keeps_markdown_inputs_and_links_escaped() {
    for marker in [
        "escapeHtml(lines.join('\\n'))",
        "escapeHtml(plain)",
        "escapeHtml(href)",
        "escapeHtml(link[3])",
        "if(/[\\u0000-\\u001f\\u007f]/.test(href))return '';",
    ] {
        assert!(
            INDEX_HTML.contains(marker),
            "missing escaping guard: {marker}"
        );
    }

    assert!(INDEX_HTML.contains("rel=\"noreferrer noopener\""));
    assert!(!INDEX_HTML.contains("href=\"${link[2]}\""));
}
