//! Static assets for the local Web UI.
//!
//! The UI lives under `apps/doggie-local-web/frontend/` as plain frontend
//! files. The Rust server only serves those assets and keeps HTTP/API logic in
//! `lib.rs`.

/// Frontend index document.
pub const INDEX_HTML: &str = include_str!("../frontend/index.html");
/// Frontend stylesheet.
pub const STYLES_CSS: &str = include_str!("../frontend/assets/styles.css");
/// Frontend application script.
pub const APP_JS: &str = include_str!("../frontend/assets/app.js");
/// Markdown renderer module imported by the application script.
pub const MARKDOWN_JS: &str = include_str!("../frontend/assets/markdown.js");

/// One static frontend asset served by the local Web UI server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrontendAsset {
    pub content_type: &'static str,
    pub body: &'static str,
}

/// Return a static frontend asset for a normalized HTTP path.
pub fn asset_for_path(path: &str) -> Option<FrontendAsset> {
    match path {
        "/" | "/index.html" => Some(FrontendAsset {
            content_type: "text/html; charset=utf-8",
            body: INDEX_HTML,
        }),
        "/assets/styles.css" => Some(FrontendAsset {
            content_type: "text/css; charset=utf-8",
            body: STYLES_CSS,
        }),
        "/assets/app.js" => Some(FrontendAsset {
            content_type: "text/javascript; charset=utf-8",
            body: APP_JS,
        }),
        "/assets/markdown.js" => Some(FrontendAsset {
            content_type: "text/javascript; charset=utf-8",
            body: MARKDOWN_JS,
        }),
        _ => None,
    }
}
