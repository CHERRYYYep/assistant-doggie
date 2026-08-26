use doggie_domain::{BucketSummaryResult, ExtractionResult, TimelineEventExtract};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ContractError;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TimelineEventInput {
    #[serde(default)]
    event_time: Option<String>,
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExtractionInput {
    summary: String,
    #[serde(default)]
    todos: Option<Vec<String>>,
    #[serde(default)]
    evidences: Option<Vec<String>>,
    #[serde(default)]
    timeline_events: Vec<TimelineEventInput>,
    #[serde(default)]
    decisions: Option<Vec<String>>,
    #[serde(default)]
    hypotheses: Option<Vec<String>>,
    #[serde(default)]
    entities: Option<Vec<String>>,
    #[serde(default)]
    tags: Option<Vec<String>>,
}

#[derive(Serialize)]
struct TimelineEventOutput<'a> {
    event_time: Option<&'a str>,
    text: &'a str,
}

#[derive(Serialize)]
struct ExtractionOutput<'a> {
    summary: &'a str,
    todos: &'a [String],
    evidences: &'a [String],
    timeline_events: Vec<TimelineEventOutput<'a>>,
    decisions: &'a [String],
    hypotheses: &'a [String],
    entities: &'a [String],
    tags: &'a [String],
}

/// Strict JSON adapter around structured extraction output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractionContract {
    inner: ExtractionResult,
}

impl ExtractionContract {
    pub fn from_json(json: &str) -> Result<Self, ContractError> {
        Self::from_value(serde_json::from_str(json)?)
    }

    pub fn from_value(value: Value) -> Result<Self, ContractError> {
        let input: ExtractionInput = serde_json::from_value(value)?;
        let timeline_events = input
            .timeline_events
            .into_iter()
            .map(|item| TimelineEventExtract::new(item.event_time, item.text))
            .collect::<Result<Vec<_>, _>>()?;
        let inner = ExtractionResult::new(
            input.summary,
            input.todos.unwrap_or_default(),
            input.evidences.unwrap_or_default(),
            timeline_events,
            input.decisions.unwrap_or_default(),
            input.hypotheses.unwrap_or_default(),
            input.entities.unwrap_or_default(),
            input.tags.unwrap_or_default(),
        )?;
        Ok(Self { inner })
    }

    pub fn to_value(&self) -> Result<Value, ContractError> {
        Ok(extraction_to_value(&self.inner)?)
    }

    pub fn to_json(&self) -> Result<String, ContractError> {
        Ok(serde_json::to_string(&self.to_value()?)?)
    }

    pub fn inner(&self) -> &ExtractionResult {
        &self.inner
    }

    pub fn into_inner(self) -> ExtractionResult {
        self.inner
    }
}

pub(crate) fn extraction_to_value(inner: &ExtractionResult) -> Result<Value, serde_json::Error> {
    serde_json::to_value(ExtractionOutput {
        summary: inner.summary(),
        todos: inner.todos(),
        evidences: inner.evidences(),
        timeline_events: inner
            .timeline_events()
            .iter()
            .map(|item| TimelineEventOutput {
                event_time: item.event_time(),
                text: item.text(),
            })
            .collect(),
        decisions: inner.decisions(),
        hypotheses: inner.hypotheses(),
        entities: inner.entities(),
        tags: inner.tags(),
    })
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BucketSummaryInput {
    summary: String,
}

/// Strict JSON adapter for a rolling Bucket summary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BucketSummaryContract {
    inner: BucketSummaryResult,
}

impl BucketSummaryContract {
    pub fn from_value(value: Value) -> Result<Self, ContractError> {
        let input: BucketSummaryInput = serde_json::from_value(value)?;
        Ok(Self {
            inner: BucketSummaryResult::new(input.summary)?,
        })
    }

    pub fn to_value(&self) -> Value {
        serde_json::json!({"summary": self.inner.summary()})
    }

    pub fn inner(&self) -> &BucketSummaryResult {
        &self.inner
    }
}
