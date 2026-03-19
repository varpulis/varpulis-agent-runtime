use std::collections::HashMap;

use crate::event::{AgentEvent, AgentEventType};
use crate::pattern::detector::{Detection, DetectionAction, DetectionSeverity, PatternDetector};

/// Configuration for the error spiral detector.
#[derive(Debug, Clone)]
pub struct ErrorSpiralConfig {
    /// Minimum number of tool errors within the window to trigger.
    pub min_error_count: u32,
    /// Sliding window size in seconds.
    pub window_seconds: u64,
    /// If set, emit Kill action when error count reaches this threshold.
    pub kill_threshold: Option<u32>,
}

impl Default for ErrorSpiralConfig {
    fn default() -> Self {
        Self {
            min_error_count: 3,
            window_seconds: 30,
            kill_threshold: None,
        }
    }
}

/// Detects repeated tool call failures within a sliding time window,
/// indicating the agent is stuck in a call-error-reformulate cycle.
pub struct ErrorSpiralDetector {
    config: ErrorSpiralConfig,
    /// Recent errors: (timestamp_ms, tool_name).
    recent_errors: Vec<(u64, String)>,
}

impl ErrorSpiralDetector {
    pub fn new(config: ErrorSpiralConfig) -> Self {
        Self {
            config,
            recent_errors: Vec::new(),
        }
    }
}

impl PatternDetector for ErrorSpiralDetector {
    fn name(&self) -> &str {
        "error_spiral"
    }

    fn process(&mut self, event: &AgentEvent) -> Vec<Detection> {
        let AgentEventType::ToolResult {
            name,
            success,
            error,
            ..
        } = &event.event_type
        else {
            return vec![];
        };

        if *success {
            return vec![];
        }

        self.recent_errors.push((event.timestamp, name.clone()));

        // Evict entries outside the window.
        let window_ms = self.config.window_seconds * 1000;
        let cutoff = event.timestamp.saturating_sub(window_ms);
        self.recent_errors.retain(|(ts, _)| *ts >= cutoff);

        let count = self.recent_errors.len() as u32;

        if count >= self.config.min_error_count {
            let should_kill = self.config.kill_threshold.is_some_and(|t| count >= t);

            // Collect unique tool names for context.
            let tool_names: Vec<&str> =
                self.recent_errors.iter().map(|(_, n)| n.as_str()).collect();

            vec![Detection {
                pattern_name: "error_spiral".into(),
                severity: if should_kill {
                    DetectionSeverity::Critical
                } else {
                    DetectionSeverity::Warning
                },
                action: if should_kill {
                    DetectionAction::Kill
                } else {
                    DetectionAction::Alert
                },
                message: format!(
                    "{} tool errors in {}s window",
                    count, self.config.window_seconds
                ),
                details: HashMap::from([
                    ("error_count".into(), serde_json::json!(count)),
                    (
                        "window_seconds".into(),
                        serde_json::json!(self.config.window_seconds),
                    ),
                    ("tool_names".into(), serde_json::json!(tool_names)),
                    ("latest_tool".into(), serde_json::json!(name)),
                    ("latest_error".into(), serde_json::json!(error)),
                ]),
                timestamp: event.timestamp,
            }]
        } else {
            vec![]
        }
    }

    fn reset(&mut self) {
        self.recent_errors.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::AgentEvent;

    fn tool_error(ts: u64, name: &str, error: &str) -> AgentEvent {
        AgentEvent::at(
            ts,
            AgentEventType::ToolResult {
                name: name.into(),
                success: false,
                error: Some(error.into()),
            },
        )
    }

    fn tool_success(ts: u64, name: &str) -> AgentEvent {
        AgentEvent::at(
            ts,
            AgentEventType::ToolResult {
                name: name.into(),
                success: true,
                error: None,
            },
        )
    }

    #[test]
    fn triggers_after_min_errors() {
        let mut det = ErrorSpiralDetector::new(ErrorSpiralConfig::default());

        assert!(det
            .process(&tool_error(1000, "search", "not found"))
            .is_empty());
        assert!(det
            .process(&tool_error(2000, "fetch", "timeout"))
            .is_empty());

        let dets = det.process(&tool_error(3000, "search", "not found"));
        assert_eq!(dets.len(), 1);
        assert_eq!(dets[0].pattern_name, "error_spiral");
    }

    #[test]
    fn does_not_trigger_on_success() {
        let mut det = ErrorSpiralDetector::new(ErrorSpiralConfig::default());

        assert!(det.process(&tool_success(1000, "search")).is_empty());
        assert!(det.process(&tool_success(2000, "search")).is_empty());
        assert!(det.process(&tool_success(3000, "search")).is_empty());
    }

    #[test]
    fn mixed_errors_across_tools() {
        let mut det = ErrorSpiralDetector::new(ErrorSpiralConfig {
            min_error_count: 3,
            window_seconds: 10,
            ..Default::default()
        });

        assert!(det.process(&tool_error(1000, "search", "err")).is_empty());
        assert!(det.process(&tool_error(2000, "fetch", "err")).is_empty());

        let dets = det.process(&tool_error(3000, "write", "err"));
        assert_eq!(dets.len(), 1);
    }

    #[test]
    fn window_eviction() {
        let mut det = ErrorSpiralDetector::new(ErrorSpiralConfig {
            min_error_count: 3,
            window_seconds: 5,
            ..Default::default()
        });

        det.process(&tool_error(1000, "a", "err"));
        det.process(&tool_error(2000, "b", "err"));
        // Third error is 11s after first — first should be evicted
        assert!(det.process(&tool_error(12000, "c", "err")).is_empty());
    }

    #[test]
    fn ignores_non_tool_result() {
        let mut det = ErrorSpiralDetector::new(ErrorSpiralConfig::default());
        let event = AgentEvent::at(
            1000,
            AgentEventType::ToolCall {
                name: "search".into(),
                params_hash: 42,
                duration_ms: 100,
            },
        );
        assert!(det.process(&event).is_empty());
    }

    #[test]
    fn reset_clears_state() {
        let mut det = ErrorSpiralDetector::new(ErrorSpiralConfig::default());

        det.process(&tool_error(1000, "a", "err"));
        det.process(&tool_error(2000, "b", "err"));
        det.reset();

        assert!(det.process(&tool_error(3000, "c", "err")).is_empty());
    }
}
