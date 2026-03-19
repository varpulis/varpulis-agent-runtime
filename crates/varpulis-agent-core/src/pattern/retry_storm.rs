use std::collections::HashMap;

use crate::event::{AgentEvent, AgentEventType};
use crate::pattern::detector::{Detection, DetectionAction, DetectionSeverity, PatternDetector};

/// Configuration for the retry storm detector.
#[derive(Debug, Clone)]
pub struct RetryStormConfig {
    /// Minimum number of identical calls to trigger detection.
    pub min_repetitions: u32,
    /// Sliding window size in seconds.
    pub window_seconds: u64,
    /// If set, emit Kill action when count reaches this threshold.
    pub kill_threshold: Option<u32>,
}

impl Default for RetryStormConfig {
    fn default() -> Self {
        Self {
            min_repetitions: 3,
            window_seconds: 10,
            kill_threshold: None,
        }
    }
}

/// Detects when the same tool is called repeatedly with identical parameters
/// within a sliding time window.
pub struct RetryStormDetector {
    config: RetryStormConfig,
    /// Ring buffer of recent tool calls: (timestamp_ms, tool_name, params_hash).
    recent_calls: Vec<(u64, String, u64)>,
}

impl RetryStormDetector {
    pub fn new(config: RetryStormConfig) -> Self {
        Self {
            config,
            recent_calls: Vec::new(),
        }
    }
}

impl PatternDetector for RetryStormDetector {
    fn name(&self) -> &str {
        "retry_storm"
    }

    fn process(&mut self, event: &AgentEvent) -> Vec<Detection> {
        let AgentEventType::ToolCall {
            name, params_hash, ..
        } = &event.event_type
        else {
            return vec![];
        };

        self.recent_calls
            .push((event.timestamp, name.clone(), *params_hash));

        // Evict entries outside the window.
        let window_ms = self.config.window_seconds * 1000;
        let cutoff = event.timestamp.saturating_sub(window_ms);
        self.recent_calls.retain(|(ts, _, _)| *ts >= cutoff);

        // Count calls matching this exact (name, params_hash).
        let count = self
            .recent_calls
            .iter()
            .filter(|(_, n, h)| n == name && h == params_hash)
            .count() as u32;

        if count >= self.config.min_repetitions {
            let should_kill = self.config.kill_threshold.is_some_and(|t| count >= t);

            vec![Detection {
                pattern_name: "retry_storm".into(),
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
                    "Tool '{}' called {} times with identical params in {}s window",
                    name, count, self.config.window_seconds
                ),
                details: HashMap::from([
                    ("tool_name".into(), serde_json::json!(name)),
                    ("params_hash".into(), serde_json::json!(params_hash)),
                    ("count".into(), serde_json::json!(count)),
                    (
                        "window_seconds".into(),
                        serde_json::json!(self.config.window_seconds),
                    ),
                ]),
                timestamp: event.timestamp,
            }]
        } else {
            vec![]
        }
    }

    fn reset(&mut self) {
        self.recent_calls.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::AgentEvent;

    fn tool_call(ts: u64, name: &str, params_hash: u64) -> AgentEvent {
        AgentEvent::at(
            ts,
            AgentEventType::ToolCall {
                name: name.into(),
                params_hash,
                duration_ms: 50,
            },
        )
    }

    #[test]
    fn triggers_on_repeated_identical_calls() {
        let mut det = RetryStormDetector::new(RetryStormConfig::default());

        assert!(det.process(&tool_call(1000, "search", 42)).is_empty());
        assert!(det.process(&tool_call(2000, "search", 42)).is_empty());

        let detections = det.process(&tool_call(3000, "search", 42));
        assert_eq!(detections.len(), 1);
        assert_eq!(detections[0].pattern_name, "retry_storm");
    }

    #[test]
    fn no_trigger_with_different_params() {
        let mut det = RetryStormDetector::new(RetryStormConfig::default());

        assert!(det.process(&tool_call(1000, "search", 1)).is_empty());
        assert!(det.process(&tool_call(2000, "search", 2)).is_empty());
        assert!(det.process(&tool_call(3000, "search", 3)).is_empty());
    }

    #[test]
    fn no_trigger_with_different_tools() {
        let mut det = RetryStormDetector::new(RetryStormConfig::default());

        assert!(det.process(&tool_call(1000, "search", 42)).is_empty());
        assert!(det.process(&tool_call(2000, "fetch", 42)).is_empty());
        assert!(det.process(&tool_call(3000, "read", 42)).is_empty());
    }

    #[test]
    fn no_trigger_outside_window() {
        let mut det = RetryStormDetector::new(RetryStormConfig {
            min_repetitions: 3,
            window_seconds: 5,
            ..Default::default()
        });

        assert!(det.process(&tool_call(1000, "search", 42)).is_empty());
        assert!(det.process(&tool_call(3000, "search", 42)).is_empty());
        // Third call is 11s after first — outside 5s window.
        assert!(det.process(&tool_call(12000, "search", 42)).is_empty());
    }

    #[test]
    fn reset_clears_state() {
        let mut det = RetryStormDetector::new(RetryStormConfig::default());

        det.process(&tool_call(1000, "search", 42));
        det.process(&tool_call(2000, "search", 42));
        det.reset();

        // After reset, a third call should not trigger (only 1 in buffer).
        assert!(det.process(&tool_call(3000, "search", 42)).is_empty());
    }

    #[test]
    fn ignores_non_tool_call_events() {
        let mut det = RetryStormDetector::new(RetryStormConfig::default());

        let event = AgentEvent::at(
            1000,
            AgentEventType::FinalAnswer {
                content_length: 100,
            },
        );
        assert!(det.process(&event).is_empty());
    }
}
