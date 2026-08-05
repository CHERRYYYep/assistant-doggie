use std::path::{Path, PathBuf};

use tempfile::{Builder, TempDir};

/// A unique temporary path kept inside an auto-cleaned directory.
///
/// SQLite sidecar files (`-wal`, `-shm`, and `-journal`) are removed with the
/// directory, so tests do not need to reimplement path uniqueness or cleanup.
pub struct TemporaryPath {
    _directory: TempDir,
    path: PathBuf,
}

impl TemporaryPath {
    pub fn new(label: &str) -> Self {
        let directory = Builder::new()
            .prefix(&format!("work-memory-{label}-"))
            .tempdir()
            .expect("temporary directory must be created");
        let path = directory.path().join("database.sqlite");
        Self {
            _directory: directory,
            path,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}
