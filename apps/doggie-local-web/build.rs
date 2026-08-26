use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const FRONTEND_MODULES: &[(&str, &str)] = &[
    ("assets/app.ts", "app.js"),
    ("assets/api.ts", "api.js"),
    ("assets/state.ts", "state.js"),
    ("assets/dom.ts", "dom.js"),
    ("assets/views.ts", "views.js"),
    ("assets/markdown.ts", "markdown.js"),
    ("assets/render-bucket.ts", "render-bucket.js"),
    ("assets/render-archive.ts", "render-archive.js"),
    ("assets/render-chat.ts", "render-chat.js"),
    ("assets/render-query.ts", "render-query.js"),
];

fn main() {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR must be set"));
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR must be set"));
    let output_dir = out_dir.join("frontend");
    fs::create_dir_all(&output_dir).expect("create frontend build output directory");

    println!("cargo:rerun-if-changed=build.rs");
    for (relative_source, output_name) in FRONTEND_MODULES {
        let source = manifest_dir.join("frontend").join(relative_source);
        println!("cargo:rerun-if-changed={}", source.display());
        let output = output_dir.join(output_name);
        strip_types(&source, &output);
    }
}

fn strip_types(source: &Path, output: &Path) {
    let script = r#"
import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const [input, destination] = process.argv.slice(1);
if (!input || !destination) {
  throw new Error("expected a TypeScript input and JavaScript output path");
}
const source = readFileSync(input, "utf8");
const javascript = stripTypeScriptTypes(source, { mode: "strip" });
writeFileSync(destination, javascript, "utf8");
"#;
    let result = Command::new("node")
        .arg("--input-type=module")
        .arg("-e")
        .arg(script)
        .arg(source)
        .arg(output)
        .output()
        .unwrap_or_else(|error| {
            panic!(
                "failed to run Node 24 to strip frontend TypeScript ({}): {error}",
                source.display()
            )
        });
    if !result.status.success() {
        panic!(
            "Node 24 failed to strip frontend TypeScript from {}:\n{}{}",
            source.display(),
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr),
        );
    }
}
