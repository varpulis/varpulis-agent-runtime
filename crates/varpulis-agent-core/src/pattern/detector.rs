use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::event::AgentEvent;

/// Trait for pattern detectors that process agent events and emit detections.
///
/// Implementors maintain internal state and are fed events one at a time.
/// This trait is designed so that a future ZDD/SASE-based engine can be
/// swapped in as a drop-in replacement.
pub trait PatternDetector: Send + Sync {
    /// The unique name of this pattern (e.g. "retry_storm").
    fn name(&self) -> &str;

    /// Process an event and return any detections triggered.
    fn process(&mut self, event: &AgentEvent) -> Vec<Detection>;

    /// Reset all internal state.
    fn reset(&mut self);
}

/// A detection emitted when a pattern matches.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Detection {
    pub pattern_name: String,
    pub severity: DetectionSeverity,
    pub message: String,
    pub details: HashMap<String, serde_json::Value>,
    pub timestamp: u64,
}

/// Severity level for a detection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DetectionSeverity {
    Info,
    Warning,
    Error,
    Critical,
}
