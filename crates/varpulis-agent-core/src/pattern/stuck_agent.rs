use std::collections::HashMap;

use crate::event::{AgentEvent, AgentEventType};
use crate::pattern::detector::{Detection, DetectionAction, DetectionSeverity, PatternDetector};

/// Configuration for the stuck agent detector.
#[derive(Debug, Clone)]
pub struct StuckAgentConfig {
    /// Maximum steps without a FinalAnswer before alerting.
    pub max_steps_without_output: u32,
    /// Maximum seconds without a FinalAnswer before alerting.
    pub max_time_without_output_seconds: u64,
    /// If set, emit Kill action when steps without output reaches this threshold.
    pub kill_threshold: Option<u32>,
}

impl Default for StuckAgentConfig {
    fn default() -> Self {
        Self {
            max_steps_without_output: 15,
            max_time_without_output_seconds: 120,
            kill_threshold: None,
        }
    }
}

/// Detects when an agent has executed too many steps or spent too long
/// without producing a final output.
pub struct StuckAgentDetector {
    config: StuckAgentConfig,
    steps_since_output: u32,
    /// Timestamp of the last FinalAnswer or the first event seen.
    last_output_ts: Option<u64>,
    /// Whether we've already fired for the current stuck period.
    fired: bool,
}

impl StuckAgentDetector {
    pub fn new(config: StuckAgentConfig) -> Self {
        Self {
            config,
            steps_since_output: 0,
            last_output_ts: None,
            fired: false,
        }
    }
}

impl PatternDetector for StuckAgentDetector {
    fn name(&self) -> &str {
        "stuck_agent"
    }

    fn process(&mut self, event: &AgentEvent) -> Vec<Detection> {
        // Initialize baseline timestamp on first event.
        if self.last_output_ts.is_none() {
            self.last_output_ts = Some(event.timestamp);
        }

        match &event.event_type {
            AgentEventType::FinalAnswer { .. } => {
                self.steps_since_output = 0;
                self.last_output_ts = Some(event.timestamp);
                self.fired = false;
                vec![]
            }
            AgentEventType::StepEnd {
                produced_output, ..
            } => {
                if *produced_output {
                    self.steps_since_output = 0;
                    self.last_output_ts = Some(event.timestamp);
                    self.fired = false;
                    return vec![];
                }

                self.steps_since_output += 1;

                if self.fired {
                    return vec![];
                }

                let steps_exceeded =
                    self.steps_since_output >= self.config.max_steps_without_output;

                let time_exceeded = self
                    .last_output_ts
                    .map(|ts| {
                        let elapsed_s = event.timestamp.saturating_sub(ts) / 1000;
                        elapsed_s >= self.config.max_time_without_output_seconds
                    })
                    .unwrap_or(false);

                if steps_exceeded || time_exceeded {
                    self.fired = true;

                    let should_kill = self
                        .config
                        .kill_threshold
                        .is_some_and(|t| self.steps_since_output >= t);

                    let reason = if steps_exceeded && time_exceeded {
                        format!(
                            "Agent stuck: {} steps and {}s without output",
                            self.steps_since_output,
                            event
                                .timestamp
                                .saturating_sub(self.last_output_ts.unwrap_or(0))
                                / 1000
                        )
                    } else if steps_exceeded {
                        format!(
                            "Agent stuck: {} steps without output (threshold: {})",
                            self.steps_since_output, self.config.max_steps_without_output
                        )
                    } else {
                        format!(
                            "Agent stuck: {}s without output (threshold: {}s)",
                            event
                                .timestamp
                                .saturating_sub(self.last_output_ts.unwrap_or(0))
                                / 1000,
                            self.config.max_time_without_output_seconds
                        )
                    };

                    vec![Detection {
                        pattern_name: "stuck_agent".into(),
                        severity: if should_kill {
                            DetectionSeverity::Critical
                        } else {
                            DetectionSeverity::Error
                        },
                        action: if should_kill {
                            DetectionAction::Kill
                        } else {
                            DetectionAction::Alert
                        },
                        message: reason,
                        details: HashMap::from([
                            (
                                "steps_since_output".into(),
                                serde_json::json!(self.steps_since_output),
                            ),
                            (
                                "seconds_since_output".into(),
                                serde_json::json!(
                                    event
                                        .timestamp
                                        .saturating_sub(self.last_output_ts.unwrap_or(0))
                                        / 1000
                                ),
                            ),
                        ]),
                        timestamp: event.timestamp,
                    }]
                } else {
                    vec![]
                }
            }
            _ => vec![],
        }
    }

    fn reset(&mut self) {
        self.steps_since_output = 0;
        self.last_output_ts = None;
        self.fired = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::AgentEvent;

    fn step_end(ts: u64, step: u32, produced_output: bool) -> AgentEvent {
        AgentEvent::at(
            ts,
            AgentEventType::StepEnd {
                step_number: step,
                produced_output,
            },
        )
    }

    fn final_answer(ts: u64) -> AgentEvent {
        AgentEvent::at(
            ts,
            AgentEventType::FinalAnswer {
                content_length: 100,
            },
        )
    }

    #[test]
    fn triggers_after_max_steps() {
        let mut det = StuckAgentDetector::new(StuckAgentConfig {
            max_steps_without_output: 3,
            max_time_without_output_seconds: 9999,
            ..Default::default()
        });

        assert!(det.process(&step_end(1000, 1, false)).is_empty());
        assert!(det.process(&step_end(2000, 2, false)).is_empty());

        let detections = det.process(&step_end(3000, 3, false));
        assert_eq!(detections.len(), 1);
        assert_eq!(detections[0].pattern_name, "stuck_agent");
    }

    #[test]
    fn triggers_after_max_time() {
        let mut det = StuckAgentDetector::new(StuckAgentConfig {
            max_steps_without_output: 9999,
            max_time_without_output_seconds: 5,
            ..Default::default()
        });

        // First event sets baseline.
        assert!(det.process(&step_end(1000, 1, false)).is_empty());
        // 6 seconds later.
        let detections = det.process(&step_end(7000, 2, false));
        assert_eq!(detections.len(), 1);
        assert!(detections[0].message.contains("without output"));
    }

    #[test]
    fn final_answer_resets_state() {
        let mut det = StuckAgentDetector::new(StuckAgentConfig {
            max_steps_without_output: 3,
            max_time_without_output_seconds: 9999,
            ..Default::default()
        });

        det.process(&step_end(1000, 1, false));
        det.process(&step_end(2000, 2, false));
        det.process(&final_answer(2500));

        // Counter reset — need 3 more steps to trigger.
        assert!(det.process(&step_end(3000, 3, false)).is_empty());
        assert!(det.process(&step_end(4000, 4, false)).is_empty());

        let detections = det.process(&step_end(5000, 5, false));
        assert_eq!(detections.len(), 1);
    }

    #[test]
    fn produced_output_resets_state() {
        let mut det = StuckAgentDetector::new(StuckAgentConfig {
            max_steps_without_output: 3,
            max_time_without_output_seconds: 9999,
            ..Default::default()
        });

        det.process(&step_end(1000, 1, false));
        det.process(&step_end(2000, 2, false));
        // This step produced output — resets counter.
        det.process(&step_end(2500, 3, true));

        assert!(det.process(&step_end(3000, 4, false)).is_empty());
        assert!(det.process(&step_end(4000, 5, false)).is_empty());

        let detections = det.process(&step_end(5000, 6, false));
        assert_eq!(detections.len(), 1);
    }

    #[test]
    fn fires_only_once_per_stuck_period() {
        let mut det = StuckAgentDetector::new(StuckAgentConfig {
            max_steps_without_output: 2,
            max_time_without_output_seconds: 9999,
            ..Default::default()
        });

        assert!(det.process(&step_end(1000, 1, false)).is_empty());
        assert_eq!(det.process(&step_end(2000, 2, false)).len(), 1);
        // Should NOT fire again.
        assert!(det.process(&step_end(3000, 3, false)).is_empty());
        assert!(det.process(&step_end(4000, 4, false)).is_empty());
    }

    #[test]
    fn reset_clears_state() {
        let mut det = StuckAgentDetector::new(StuckAgentConfig {
            max_steps_without_output: 3,
            max_time_without_output_seconds: 9999,
            ..Default::default()
        });

        det.process(&step_end(1000, 1, false));
        det.process(&step_end(2000, 2, false));
        det.reset();

        assert!(det.process(&step_end(3000, 3, false)).is_empty());
        assert!(det.process(&step_end(4000, 4, false)).is_empty());

        let detections = det.process(&step_end(5000, 5, false));
        assert_eq!(detections.len(), 1);
    }
}
