//! Structural contract for the bundled frontend.
//!
//! These assertions cover facts about how the UI is *assembled* — which assets
//! exist, how they import each other, and which server routes they depend on.
//!
//! They deliberately do **not** assert on the source text of the renderer.
//! Assertions of that shape (`APP_JS.contains("escapeHtml(plain)")`) tested
//! spelling rather than behaviour: reformatting the file broke all of them
//! while changing nothing, and a real injection bug would have left them
//! passing. Renderer behaviour — escaping, URL filtering, fenced-code
//! containment and the injection payloads each rule exists to stop — is
//! covered by executable tests in `frontend/tests/markdown.test.ts`
//! (`npm test --prefix apps/doggie-local-web/frontend`).

use doggie_local_web::{
    APP_JS, FRONTEND_ASSETS, INDEX_HTML, MARKDOWN_JS, STYLES_CSS, asset_for_path, frontend_scripts,
};

#[test]
fn frontend_is_split_into_external_assets() {
    assert!(INDEX_HTML.contains("assets/styles.css"));
    assert!(INDEX_HTML.contains("assets/app.ts"));
    assert!(
        !INDEX_HTML.contains("<style>"),
        "styles must stay in styles.css"
    );
    assert!(
        !INDEX_HTML.contains("<script>"),
        "scripts must stay in app.ts"
    );
    assert!(
        INDEX_HTML.contains(r#"<script type="module" src="assets/app.ts">"#),
        "app.ts must load as an ES module"
    );
    for asset in FRONTEND_ASSETS {
        assert!(!asset.body.is_empty(), "empty asset: {}", asset.path);
    }
}

/// Every `import ... from "./x.ts"` must resolve to an asset the server routes.
///
/// A module that is imported but never registered in `FRONTEND_ASSETS` returns
/// 404 and breaks the page with no server-side error, so this is the check that
/// makes the split safe to extend.
#[test]
fn every_imported_module_is_served() {
    let mut checked = 0;
    for (path, source) in frontend_scripts() {
        for specifier in import_specifiers(source) {
            let resolved = format!("/assets/{specifier}");
            assert!(
                asset_for_path(&resolved).is_some(),
                "{path} imports {specifier}, which is not served"
            );
            checked += 1;
        }
    }
    assert!(checked > 0, "no imports found; the parser is broken");
    assert!(asset_for_path("/assets/missing.ts").is_none());
}

/// `/` and `/index.html` must be the same document.
#[test]
fn index_is_reachable_from_the_site_root() {
    let root = asset_for_path("/").expect("root asset");
    let index = asset_for_path("/index.html").expect("index asset");
    assert_eq!(root, index);
    assert_eq!(root.content_type, "text/html; charset=utf-8");
}

/// Each module keeps one job: only `dom.ts` touches the document, only
/// `api.ts` calls the network, only `state.ts` owns mutable state.
#[test]
fn module_responsibilities_do_not_leak() {
    let module = |name: &str| {
        frontend_scripts()
            .find(|(path, _)| *path == name)
            .unwrap_or_else(|| panic!("missing module {name}"))
            .1
    };

    for (path, source) in frontend_scripts() {
        if path != "/assets/dom.ts" {
            assert!(
                !source.contains("document.querySelector"),
                "{path} queries the DOM directly; element handles belong in dom.ts"
            );
        }
        if path != "/assets/api.ts" {
            assert!(
                !source.contains("fetch("),
                "{path} calls fetch directly; network access belongs in api.ts"
            );
        }
    }

    assert!(
        module("/assets/app.ts").contains("addEventListener"),
        "app.ts is the wiring module"
    );
    assert!(
        !module("/assets/markdown.ts").contains("import "),
        "the renderer must stay dependency-free so it can be unit tested"
    );
    assert!(
        MARKDOWN_JS
            .matches("export function renderMarkdown")
            .count()
            == 1,
        "markdown.ts must export exactly one renderer"
    );
    assert!(
        !APP_JS.contains("function renderMarkdown"),
        "the renderer must live only in markdown.ts"
    );
}

#[test]
fn rust_embeds_browser_javascript_not_typescript_source() {
    for (path, source) in frontend_scripts() {
        assert!(
            !source.contains("import type"),
            "TS import survived in {path}"
        );
        assert!(
            !source.contains("export type"),
            "TS export survived in {path}"
        );
        assert!(
            !source.contains("satisfies "),
            "TS satisfies survived in {path}"
        );
        assert!(
            !source.contains(" as const"),
            "TS const assertion survived in {path}"
        );
    }
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
    assert!(!INDEX_HTML.contains("style=\""));
    for (path, source) in frontend_scripts() {
        assert!(
            !source.contains("style=\""),
            "{path} emits an inline style attribute, which the CSP forbids"
        );
    }
}

/// The routes the UI calls must match the ones the server dispatches, and they
/// must all be declared in one place.
#[test]
fn server_routes_are_declared_only_in_the_api_module() {
    let api = frontend_scripts()
        .find(|(path, _)| *path == "/assets/api.ts")
        .expect("api.ts")
        .1;

    for route in [
        "/api/chat",
        "/api/chat/confirm",
        "/api/chat/history",
        "/api/buckets/active",
        "/api/memory/query",
        "/api/corrections/move",
    ] {
        assert!(api.contains(route), "api.ts no longer declares {route}");
    }

    for (path, source) in frontend_scripts() {
        if path != "/assets/api.ts" {
            assert!(
                !source.contains("\"/api/"),
                "{path} hard-codes a server route; routes belong in api.ts"
            );
        }
    }

    // Removed in the frontend split; these were declared but never referenced.
    for dead in ["legacyArchiveRoute", "legacyConfirmRoutes"] {
        assert!(!APP_JS.contains(dead), "dead constant is back: {dead}");
    }
}

#[test]
fn bucket_delete_and_auto_association_controls_are_present() {
    let bundle: String = frontend_scripts().map(|(_, source)| source).collect();
    assert!(bundle.contains("export async function deleteBucket"));
    assert!(bundle.contains(r#"data-action="delete-bucket""#));
    assert!(INDEX_HTML.contains("自动关联最近和热门 Bucket"));
    assert!(
        !bundle.contains("focus_bucket_id"),
        "bucket candidates are chosen server-side"
    );
}

/// Collect the `./x.ts` specifiers a module imports.
fn import_specifiers(source: &str) -> Vec<&str> {
    source
        .match_indices("from \"./")
        .filter_map(|(index, marker)| {
            let rest = &source[index + marker.len()..];
            rest.find('"').map(|end| &rest[..end])
        })
        .collect()
}
