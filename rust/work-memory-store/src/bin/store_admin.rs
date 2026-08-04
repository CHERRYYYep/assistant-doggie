//! Offline administration commands for the Rust-managed SQLite schema.

use std::env;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::ExitCode;

use work_memory_store::{
    MigrationOutcome, SchemaInfo, SchemaState, inspect_database, migrate_database, restore_database,
};

const USAGE: &str = "Usage:\n  work-memory-store-admin inspect DATABASE\n  work-memory-store-admin migrate DATABASE BACKUP\n  work-memory-store-admin restore DATABASE BACKUP SAFETY_BACKUP";

fn main() -> ExitCode {
    match run(env::args_os().skip(1).collect()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(AdminError::Usage(message)) => {
            eprintln!("{message}\n\n{USAGE}");
            ExitCode::from(2)
        }
        Err(AdminError::Store(error)) => {
            eprintln!("work-memory-store-admin: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run(arguments: Vec<OsString>) -> Result<(), AdminError> {
    let Some(command) = arguments.first().and_then(|value| value.to_str()) else {
        return Err(AdminError::Usage("a command is required"));
    };

    match (command, &arguments[1..]) {
        ("inspect", [database]) => {
            let info = inspect_database(PathBuf::from(database))?;
            print_schema_info(&info);
        }
        ("migrate", [database, backup]) => {
            match migrate_database(PathBuf::from(database), PathBuf::from(backup))? {
                MigrationOutcome::Migrated {
                    from,
                    to,
                    backup_path,
                } => println!(
                    "migrated {} -> {}; backup={}",
                    state_label(from),
                    state_label(to),
                    backup_path.display()
                ),
                MigrationOutcome::AlreadyCurrent { version } => {
                    println!("already current; version={version}")
                }
            }
        }
        ("restore", [database, backup, safety_backup]) => {
            let outcome = restore_database(
                PathBuf::from(database),
                PathBuf::from(backup),
                PathBuf::from(safety_backup),
            )?;
            println!(
                "restored {} -> {}; safety_backup={}",
                state_label(outcome.previous_state),
                state_label(outcome.restored_state),
                outcome.safety_backup_path.display()
            );
        }
        ("inspect" | "migrate" | "restore", _) => {
            return Err(AdminError::Usage(
                "the command received the wrong number of paths",
            ));
        }
        _ => return Err(AdminError::Usage("unknown command")),
    }
    Ok(())
}

fn print_schema_info(info: &SchemaInfo) {
    println!("state={}", state_label(info.state));
    for migration in &info.migrations {
        println!(
            "migration={} name={} applied_at={}",
            migration.version, migration.name, migration.applied_at
        );
    }
}

fn state_label(state: SchemaState) -> String {
    match state {
        SchemaState::LegacyPython => "legacy-python".to_owned(),
        SchemaState::Versioned(version) => format!("version-{version}"),
    }
}

enum AdminError {
    Usage(&'static str),
    Store(work_memory_store::StoreError),
}

impl From<work_memory_store::StoreError> for AdminError {
    fn from(error: work_memory_store::StoreError) -> Self {
        Self::Store(error)
    }
}
