use chrono::{DateTime, NaiveDate, NaiveDateTime, SecondsFormat, Timelike};

use crate::ContractError;

/// Validate and normalize a JSON datetime string like Pydantic's JSON output.
pub(crate) fn parse_timestamp(value: String) -> Result<(String, i64), ContractError> {
    if let Ok(parsed) = DateTime::parse_from_rfc3339(&value) {
        let seconds_format = seconds_format(parsed.nanosecond());
        let normalized = parsed.to_rfc3339_opts(seconds_format, true);
        return Ok((normalized, parsed.timestamp_millis()));
    }

    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f"] {
        if let Ok(parsed) = NaiveDateTime::parse_from_str(&value, format) {
            let normalized = format_naive(parsed);
            return Ok((normalized, parsed.and_utc().timestamp_millis()));
        }
    }

    if let Ok(parsed) = NaiveDate::parse_from_str(&value, "%Y-%m-%d") {
        let parsed = parsed
            .and_hms_opt(0, 0, 0)
            .expect("midnight is always a valid time");
        return Ok((format_naive(parsed), parsed.and_utc().timestamp_millis()));
    }

    Err(ContractError::InvalidTimestamp(value))
}

fn seconds_format(nanosecond: u32) -> SecondsFormat {
    if nanosecond == 0 {
        SecondsFormat::Secs
    } else {
        SecondsFormat::Micros
    }
}

fn format_naive(value: NaiveDateTime) -> String {
    if value.nanosecond() == 0 {
        value.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        value.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
    }
}
