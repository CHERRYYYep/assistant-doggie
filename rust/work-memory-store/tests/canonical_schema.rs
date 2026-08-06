mod support;

use std::path::{Path, PathBuf};
use std::process::Command;

use rusqlite::Connection;
use support::TemporaryPath;
use work_memory_store::{RustStore, StoreError};

#[test]
fn initializes_and_validates_a_rust_owned_schema() {
    let database = TemporaryPath::new("canonical-schema");
    let store = RustStore::initialize(database.path()).expect("canonical schema must initialize");

    assert!(!store.is_read_only().expect("write store must be writable"));
    assert!(
        store
            .foreign_keys_enabled()
            .expect("foreign-key pragma must be readable")
    );
    assert_eq!(store.counts().expect("empty counts").buckets, 0);

    let connection = Connection::open(database.path()).expect("database must open");
    let marker: String = connection
        .query_row(
            "SELECT value FROM rust_schema_meta WHERE key = 'schema_kind'",
            [],
            |row| row.get(0),
        )
        .expect("canonical schema marker must exist");
    assert_eq!(marker, "rust-work-memory");
    let version: String = connection
        .query_row(
            "SELECT value FROM rust_schema_meta WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .expect("canonical schema version must exist");
    assert_eq!(version, "1");

    drop(store);
    let read_only = RustStore::open_read_only(database.path()).expect("canonical read-only open");
    assert!(
        read_only
            .is_read_only()
            .expect("read-only flag must be enabled")
    );
    assert!(
        read_only
            .foreign_keys_enabled()
            .expect("read-only foreign-key pragma must be readable")
    );

    drop(read_only);
    let reopened = RustStore::initialize(database.path()).expect("existing canonical open");
    assert!(
        reopened
            .foreign_keys_enabled()
            .expect("existing canonical write store must enable foreign keys")
    );
}

#[test]
fn refuses_to_initialize_a_database_with_unknown_user_objects() {
    let database = TemporaryPath::new("canonical-non-empty");
    let connection = Connection::open(database.path()).expect("database must open");
    connection
        .execute("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)", [])
        .expect("unrelated table must be created");
    drop(connection);

    assert!(matches!(
        RustStore::initialize(database.path()),
        Err(StoreError::CanonicalSchemaAlreadyExists)
    ));
}

#[test]
fn rejects_extra_objects_in_an_empty_canonical_database() {
    let database = TemporaryPath::new("canonical-extra-object");
    let store = RustStore::initialize(database.path()).expect("canonical schema");
    drop(store);

    let connection = Connection::open(database.path()).expect("database must open");
    connection
        .execute("CREATE TABLE unexpected (id TEXT PRIMARY KEY)", [])
        .expect("extra table must be created");
    drop(connection);

    assert!(matches!(
        RustStore::open_existing(database.path()),
        Err(StoreError::UnexpectedCanonicalObject { object_type, name })
            if object_type == "table" && name == "unexpected"
    ));
}

#[test]
fn rejects_a_missing_canonical_index_even_when_the_database_is_empty() {
    let database = TemporaryPath::new("canonical-missing-index");
    let store = RustStore::initialize(database.path()).expect("canonical schema");
    drop(store);

    let connection = Connection::open(database.path()).expect("database must open");
    connection
        .execute("DROP INDEX ix_entries_created", [])
        .expect("canonical index must be removable for the regression test");
    drop(connection);

    assert!(matches!(
        RustStore::open_existing(database.path()),
        Err(StoreError::MissingIndex {
            table: "entries",
            index: "ix_entries_created"
        })
    ));
}

#[test]
fn legacy_python_database_cannot_be_opened_as_rust_canonical_storage() {
    let database = TemporaryPath::new("canonical-legacy");
    create_python_fixture(database.path());

    assert!(matches!(
        RustStore::open_existing(database.path()),
        Err(StoreError::CanonicalSchemaMarkerMissing)
    ));
    assert!(matches!(
        RustStore::initialize(database.path()),
        Err(StoreError::CanonicalSchemaAlreadyExists)
    ));
}

fn create_python_fixture(database_path: &Path) {
    let repository_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("store crate must live under rust/")
        .to_owned();
    let virtualenv_python = repository_root.join(".venv/bin/python");
    let python = if virtualenv_python.is_file() {
        virtualenv_python
    } else {
        PathBuf::from("python3")
    };
    let fixture_script = repository_root.join("tests/fixtures/create_sqlite_compat_fixture.py");
    let output = Command::new(python)
        .arg(fixture_script)
        .arg(database_path)
        .env("PYTHONPATH", &repository_root)
        .current_dir(&repository_root)
        .output()
        .expect("Python fixture generator must start");
    assert!(
        output.status.success(),
        "Python fixture generator failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
