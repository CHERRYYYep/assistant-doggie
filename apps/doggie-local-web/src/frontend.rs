//! Static assets for the local Web UI.
//!
//! The UI lives under `apps/doggie-local-web/frontend/` as plain ES modules
//! with no build step: the server embeds the source files verbatim and serves
//! them same-origin. Node is used only for formatting and tests.
//!
//! Adding a module means adding one row to [`FRONTEND_ASSETS`]. The
//! `every_referenced_asset_path_is_served` test fails if a module is imported
//! but never registered here.

/// Frontend index document.
pub const INDEX_HTML: &str = include_str!("../frontend/index.html");
/// Frontend stylesheet.
pub const STYLES_CSS: &str = include_str!("../frontend/assets/styles.css");
/// Entry point: binds DOM events to controllers.
pub const APP_JS: &str = include_str!("../frontend/assets/app.js");
/// Markdown renderer.
pub const MARKDOWN_JS: &str = include_str!("../frontend/assets/markdown.js");
/// Server routes and JSON transport.
pub const API_JS: &str = include_str!("../frontend/assets/api.js");
/// The single mutable state object.
pub const STATE_JS: &str = include_str!("../frontend/assets/state.js");
/// Element handles and the status line.
pub const DOM_JS: &str = include_str!("../frontend/assets/dom.js");
/// Controllers: fetch, mutate state, re-render.
pub const VIEWS_JS: &str = include_str!("../frontend/assets/views.js");
/// Bucket presentation helpers.
pub const RENDER_BUCKET_JS: &str = include_str!("../frontend/assets/render-bucket.js");
/// Archive result and confirmation card.
pub const RENDER_ARCHIVE_JS: &str = include_str!("../frontend/assets/render-archive.js");
/// Chat transcript rendering.
pub const RENDER_CHAT_JS: &str = include_str!("../frontend/assets/render-chat.js");
/// Memory query plan and results.
pub const RENDER_QUERY_JS: &str = include_str!("../frontend/assets/render-query.js");

const HTML: &str = "text/html; charset=utf-8";
const CSS: &str = "text/css; charset=utf-8";
const JS: &str = "text/javascript; charset=utf-8";

/// One static frontend asset served by the local Web UI server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrontendAsset {
    pub path: &'static str,
    pub content_type: &'static str,
    pub body: &'static str,
}

const fn asset(
    path: &'static str,
    content_type: &'static str,
    body: &'static str,
) -> FrontendAsset {
    FrontendAsset {
        path,
        content_type,
        body,
    }
}

/// Every asset the UI can request, in routing order.
pub const FRONTEND_ASSETS: &[FrontendAsset] = &[
    asset("/index.html", HTML, INDEX_HTML),
    asset("/assets/styles.css", CSS, STYLES_CSS),
    asset("/assets/app.js", JS, APP_JS),
    asset("/assets/api.js", JS, API_JS),
    asset("/assets/state.js", JS, STATE_JS),
    asset("/assets/dom.js", JS, DOM_JS),
    asset("/assets/views.js", JS, VIEWS_JS),
    asset("/assets/markdown.js", JS, MARKDOWN_JS),
    asset("/assets/render-bucket.js", JS, RENDER_BUCKET_JS),
    asset("/assets/render-archive.js", JS, RENDER_ARCHIVE_JS),
    asset("/assets/render-chat.js", JS, RENDER_CHAT_JS),
    asset("/assets/render-query.js", JS, RENDER_QUERY_JS),
];

/// Return a static frontend asset for a normalized HTTP path.
pub fn asset_for_path(path: &str) -> Option<FrontendAsset> {
    let path = if path == "/" { "/index.html" } else { path };
    FRONTEND_ASSETS
        .iter()
        .find(|candidate| candidate.path == path)
        .copied()
}

/// Every JavaScript module, as `(path, source)`, for contract tests.
pub fn frontend_scripts() -> impl Iterator<Item = (&'static str, &'static str)> {
    FRONTEND_ASSETS
        .iter()
        .filter(|asset| asset.content_type == JS)
        .map(|asset| (asset.path, asset.body))
}
