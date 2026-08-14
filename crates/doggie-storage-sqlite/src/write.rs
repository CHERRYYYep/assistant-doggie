use std::path::Path;

use rusqlite::{Connection, DatabaseName, OpenFlags, Transaction, TransactionBehavior};

use crate::{StoreError, migration, schema};

/// Writable SQLite repository foundation for the validated legacy business schema.
///
/// Public mutation methods are strongly typed business operations. The raw
/// writable connection and transaction closure remain private so application
/// callers cannot bypass archive invariants with arbitrary SQL.
pub struct WritableSqliteStore {
    connection: Connection,
    validated_schema_version: i64,
}

impl WritableSqliteStore {
    /// Open an existing database for isolated Doggie writes.
    ///
    /// The database file must already exist, contain the complete supported
    /// legacy schema, pass SQLite integrity checks, and have a supported
    /// migration history. Foreign-key enforcement is enabled before the store
    /// can be used.
    pub fn open_existing(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.execute_batch("PRAGMA foreign_keys = ON;")?;

        ensure_write_ready(&connection)?;
        migration::ensure_supported_history_if_present(&connection)?;
        schema::validate_full_legacy_schema(&connection)?;
        let validated_schema_version = schema_version(&connection)?;

        Ok(Self {
            connection,
            validated_schema_version,
        })
    }

    /// Report whether the connection remains writable with foreign keys on.
    pub fn is_write_ready(&self) -> Result<bool, StoreError> {
        connection_is_write_ready(&self.connection)
    }

    /// Run one immediate transaction and commit only after the operation succeeds.
    ///
    /// Keeping this crate-private prevents application code from bypassing the
    /// typed business write APIs and their aggregate invariants.
    pub(crate) fn run_transaction<T>(
        &mut self,
        operation: impl FnOnce(&Transaction<'_>) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        ensure_write_ready(&self.connection)?;
        migration::ensure_supported_history_if_present(&self.connection)?;

        let current_schema_version = schema_version(&self.connection)?;
        if current_schema_version != self.validated_schema_version {
            return Err(StoreError::SchemaChangedAfterValidation {
                expected: self.validated_schema_version,
                found: current_schema_version,
            });
        }

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        match operation(&transaction) {
            Ok(value) => {
                transaction.commit()?;
                Ok(value)
            }
            Err(operation_error) => {
                transaction.rollback()?;
                Err(operation_error)
            }
        }
    }
}

fn ensure_write_ready(connection: &Connection) -> Result<(), StoreError> {
    let opened_read_only = connection.is_readonly(DatabaseName::Main)?;
    let query_only = pragma_enabled(connection, "query_only")?;
    let foreign_keys = pragma_enabled(connection, "foreign_keys")?;
    if opened_read_only || query_only || !foreign_keys {
        return Err(StoreError::WriteConnectionNotReady {
            opened_read_only,
            query_only,
            foreign_keys,
        });
    }
    Ok(())
}

fn connection_is_write_ready(connection: &Connection) -> Result<bool, StoreError> {
    let opened_read_only = connection.is_readonly(DatabaseName::Main)?;
    let query_only = pragma_enabled(connection, "query_only")?;
    let foreign_keys = pragma_enabled(connection, "foreign_keys")?;
    Ok(!opened_read_only && !query_only && foreign_keys)
}

fn pragma_enabled(connection: &Connection, pragma: &str) -> Result<bool, StoreError> {
    let sql = format!("PRAGMA {pragma}");
    Ok(connection.query_row(&sql, [], |row| row.get::<_, i64>(0))? == 1)
}

fn schema_version(connection: &Connection) -> Result<i64, StoreError> {
    Ok(connection.query_row("PRAGMA schema_version", [], |row| row.get(0))?)
}
