//! Structural contract for the bundled frontend.
//!
//! These assertions cover facts about how the UI is *assembled* — which assets
//! exist, how they are wired together, and which server routes they depend on.
//!
//! They deliberately do **not** assert on the source text of the renderer.
//! Assertions of that shape (`APP_JS.contains("escapeHtml(plain)")`) tested
//! spelling rather than behaviour: reformatting the file broke all of them
//! while changing nothing, and a real injection bug would have left them
//! passing. Renderer behaviour — escaping, URL filtering, fenced-code
//! containment and the injection payloads each rule exists to stop — is now
//! covered by executable tests in `frontend/tests/markdown.test.js`
//! (`npm test --prefix apps/doggie-local-web/frontend`).

use doggie_local_web::{APP_JS, INDEX_HTML, MARKDOWN_JS, STYLES_CSS};

#[test]
fn frontend_is_split_into_external_assets() {
    assert!(INDEX_HTML.contains("assets/styles.css"));
    assert!(INDEX_HTML.contains("assets/app.js"));
    assert!(
        !INDEX_HTML.contains("<style>"),
        "styles must stay in styles.css"
    );
    assert!(
        !INDEX_HTML.contains("<script>"),
        "scripts must stay in app.js"
    );
    assert!(!STYLES_CSS.is_empty());
    assert!(!APP_JS.is_empty());
    assert!(!MARKDOWN_JS.is_empty());
}

#[test]
fn app_script_loads_as_a_module_and_imports_the_single_renderer() {
    assert!(
        INDEX_HTML.contains(r#"<script type="module" src="assets/app.js">"#),
        "app.js must load as an ES module so it can import markdown.js"
    );
    assert!(
        APP_JS.contains(r#"from "./markdown.js""#),
        "app.js must import the renderer instead of defining its own"
    );
    assert!(
        !APP_JS.contains("function renderMarkdown"),
        "the renderer must live only in markdown.js"
    );
    assert!(
        MARKDOWN_JS
            .matches("export function renderMarkdown")
            .count()
            == 1,
        "markdown.js must export exactly one renderer"
    );
}

/// Every asset the UI references must actually be routable.
#[test]
fn every_referenced_asset_path_is_served() {
    for path in [
        "/",
        "/index.html",
        "/assets/styles.css",
        "/assets/app.js",
        "/assets/markdown.js",
    ] {
        assert!(
            doggie_local_web::asset_for_path(path).is_some(),
            "unrouted asset path: {path}"
        );
    }
    assert!(doggie_local_web::asset_for_path("/assets/missing.js").is_none());
}

/// The stylesheet must not hard-code a colour outside the token blocks, or a
/// new surface will silently look wrong in one of the two themes.
#[test]
fn stylesheet_defines_light_and_dark_tokens() {
    assert!(STYLES_CSS.contains("color-scheme: light dark"));
    assert!(STYLES_CSS.contains("@media (prefers-color-scheme: dark)"));

    let light_tokens = STYLES_CSS
        .split("@media (prefers-color-scheme: dark)")
        .next()
        .expect("light block");
    for token in ["--bg", "--panel", "--line", "--text", "--muted", "--accent"] {
        assert!(
            light_tokens.contains(&format!("{token}:")),
            "missing light token: {token}"
        );
    }
}

/// A CSP without `'unsafe-inline'` only holds if nothing emits inline styles.
#[test]
fn no_asset_emits_inline_style_attributes() {
    for (name, source) in [
        ("index.html", INDEX_HTML),
        ("app.js", APP_JS),
        ("markdown.js", MARKDOWN_JS),
    ] {
        assert!(
            !source.contains("style=\""),
            "{name} emits an inline style attribute, which the CSP forbids"
        );
    }
}

/// The routes the UI calls must match the ones the server dispatches.
#[test]
fn app_script_calls_only_live_server_routes() {
    for route in [
        "/api/chat",
        "/api/chat/confirm",
        "/api/chat/history",
        "/api/buckets/active",
        "/api/memory/query",
        "/api/corrections/move",
    ] {
        assert!(APP_JS.contains(route), "app.js no longer calls {route}");
    }

    // Removed in the frontend split; these were declared but never referenced.
    for dead in ["legacyArchiveRoute", "legacyConfirmRoutes"] {
        assert!(!APP_JS.contains(dead), "dead constant is back: {dead}");
    }
}

#[test]
fn bucket_delete_and_auto_association_controls_are_present() {
    assert!(APP_JS.contains("async function deleteBucket"));
    assert!(APP_JS.contains(r#"data-action="delete-bucket""#));
    assert!(INDEX_HTML.contains("自动关联最近和热门 Bucket"));
    assert!(
        !APP_JS.contains("focus_bucket_id"),
        "bucket candidates are chosen server-side"
    );
}
