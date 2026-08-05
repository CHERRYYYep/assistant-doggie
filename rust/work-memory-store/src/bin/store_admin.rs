//! Offline administration commands for the Rust-managed SQLite schema.

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use thiserror::Error;
use work_memory_store::{
    MigrationOutcome, SchemaInfo, SchemaState, StoreError, inspect_database, migrate_database,
    restore_database,
};

#[derive(Debug, Parser)]
#[command(name = "work-memory-store-admin")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Inspect {
        database: PathBuf,
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
        SchemaState::LegacyPython => "legacy-python".to_owned(),
        SchemaState::Versioned(version) => format!("version-{version}"),
    }
}

#[derive(Debug, Error)]
enum AdminError {
    #[error(transparent)]
    Store(#[from] StoreError),
}
