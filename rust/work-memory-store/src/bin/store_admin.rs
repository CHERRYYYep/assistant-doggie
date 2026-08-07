//! Offline administration commands for the Rust-managed SQLite schema.

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use thiserror::Error;
use work_memory_store::{
    MigrationOutcome, RustStore, SchemaInfo, SchemaState, StoreError, inspect_database,
    migrate_database, restore_database,
};

#[derive(Debug, Parser)]
#[command(name = "work-memory-store-admin")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Inspect the legacy-compatible database.
    Inspect {
        database: PathBuf,
    },
    /// Initialize a new Rust-owned canonical database.
    Init {
        rust_db: PathBuf,
    },
    /// Import semantic memory from a legacy database into a new Rust database.
    ImportLegacy {
        legacy_db: PathBuf,
        rust_db: PathBuf,
    },
    /// Validate and inspect a Rust-owned canonical database.
    InspectRust {
        rust_db: PathBuf,
    },
    Migrate {
        database: PathBuf,
        backup: PathBuf,
    },
    Restore {
        database: PathBuf,
        backup: PathBuf,
        safety_backup: PathBuf,
    },
}

fn main() -> ExitCode {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(error) => {
            eprint!("{error}");
            return ExitCode::from(error.exit_code() as u8);
        }
    };

    match run(cli.command) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("work-memory-store-admin: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run(command: Command) -> Result<(), AdminError> {
    match command {
        Command::Inspect { database } => {
            let info = inspect_database(database)?;
            print_schema_info(&info);
        }
        Command::Init { rust_db } => {
            let _store = RustStore::initialize(&rust_db)?;
            println!("initialized Rust canonical database: {}", rust_db.display());
        }
        Command::ImportLegacy { legacy_db, rust_db } => {
            let report = RustStore::import_legacy_database(&legacy_db, &rust_db)?;
            println!(
                "imported legacy database {} -> {}: buckets={} entries={} memory_items={} archive_attempts={} corrections={} chat_messages={}",
                legacy_db.display(),
                rust_db.display(),
                report.buckets,
                report.entries,
                report.memory_items,
                report.archive_attempts,
                report.corrections,
                report.chat_messages,
            );
        }
        Command::InspectRust { rust_db } => {
            let store = RustStore::open_read_only(&rust_db)?;
            let counts = store.counts()?;
            println!("state=rust-canonical");
            println!("path={}", rust_db.display());
            println!(
                "counts buckets={} entries={} memory_items={} archive_attempts={} corrections={} chat_messages={}",
                counts.buckets,
                counts.entries,
                counts.memory_items,
                counts.archive_attempts,
                counts.corrections,
                counts.chat_messages,
            );
        }
        Command::Migrate { database, backup } => match migrate_database(database, backup)? {
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
        },
        Command::Restore {
            database,
            backup,
            safety_backup,
        } => {
            let outcome = restore_database(database, backup, safety_backup)?;
            println!(
                "restored {} -> {}; safety_backup={}",
                state_label(outcome.previous_state),
                state_label(outcome.restored_state),
                outcome.safety_backup_path.display()
            );
        }
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
        SchemaState::Legacy => "legacy".to_owned(),
        SchemaState::Versioned(version) => format!("version-{version}"),
    }
}

#[derive(Debug, Error)]
enum AdminError {
    #[error(transparent)]
    Store(#[from] StoreError),
}
