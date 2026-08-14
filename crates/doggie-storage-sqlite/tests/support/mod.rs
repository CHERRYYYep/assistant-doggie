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
            .prefix(&format!("doggie-{label}-"))
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

/// Assert that a generated identifier is a canonical RFC 4122 version 4 UUID.
#[allow(dead_code)]
pub fn assert_uuid_v4(value: &str) {
    let uuid = uuid::Uuid::parse_str(value).expect("value must be a UUID");
    assert_eq!(uuid.get_version(), Some(uuid::Version::Random));
    assert_eq!(uuid.get_variant(), uuid::Variant::RFC4122);
    assert_eq!(uuid.hyphenated().to_string(), value);
}
