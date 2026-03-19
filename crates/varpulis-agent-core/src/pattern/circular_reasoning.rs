use std::collections::HashMap;

use crate::event::{AgentEvent, AgentEventType};
use crate::pattern::detector::{Detection, DetectionAction, DetectionSeverity, PatternDetector};

/// Configuration for the circular reasoning detector.
#[derive(Debug, Clone)]
pub struct CircularReasoningConfig {
    /// Maximum cycle length to detect (e.g., A→B→C is length 3).
    pub max_cycle_length: u32,
    /// Minimum number of times the cycle must repeat.
    pub min_cycle_repetitions: u32,
}

impl Default for CircularReasoningConfig {
    fn default() -> Self {
        Self {
            max_cycle_length: 4,
            min_cycle_repetitions: 2,
        }
    }
}

/// Detects when an agent's tool call sequence forms a repeating cycle,
/// indicating it's stuck alternating between tools without progressing.
pub struct CircularReasoningDetector {
    config: CircularReasoningConfig,
    /// Ordered sequence of recent tool call names.
    tool_sequence: Vec<String>,
    /// The cycle we last fired for, to avoid repeat alerts.
    fired_for_cycle: Option<Vec<String>>,
    /// Maximum entries to keep in tool_sequence.
    max_entries: usize,
}

impl CircularReasoningDetector {
    pub fn new(config: CircularReasoningConfig) -> Self {
        let max_entries = (config.max_cycle_length * (config.min_cycle_repetitions + 1)) as usize;
        Self {
            config,
            tool_sequence: Vec::new(),
            fired_for_cycle: None,
            max_entries,
        }
    }

    /// Normalize a cycle to its lexicographically smallest rotation.
    /// This ensures `[a,b]` and `[b,a]` are treated as the same cycle.
    fn normalize_cycle(cycle: &[String]) -> Vec<String> {
        let n = cycle.len();
        let mut min_rotation = cycle.to_vec();
        for i in 1..n {
            let rotation: Vec<_> = cycle[i..]
                .iter()
                .chain(cycle[..i].iter())
                .cloned()
                .collect();
            if rotation < min_rotation {
                min_rotation = rotation;
            }
        }
        min_rotation
    }

    /// Check if the tail of tool_sequence contains a repeating cycle.
    fn detect_cycle(&self) -> Option<Vec<String>> {
        let seq = &self.tool_sequence;
        let len = seq.len();

        for cycle_len in 2..=self.config.max_cycle_length as usize {
            let needed = cycle_len * self.config.min_cycle_repetitions as usize;
            if len < needed {
                continue;
            }

            // Extract the candidate cycle from the tail.
            let candidate = &seq[len - cycle_len..len];

            // Check if it repeats min_cycle_repetitions times consecutively.
            let mut matches = true;
            for rep in 1..self.config.min_cycle_repetitions as usize {
                let start = len - cycle_len * (rep + 1);
                let end = start + cycle_len;
                if &seq[start..end] != candidate {
                    matches = false;
                    break;
                }
            }

            if matches {
                return Some(Self::normalize_cycle(candidate));
            }
        }

        None
    }
}

impl PatternDetector for CircularReasoningDetector {
    fn name(&self) -> &str {
        "circular_reasoning"
    }

    fn process(&mut self, event: &AgentEvent) -> Vec<Detection> {
        let AgentEventType::ToolCall { name, .. } = &event.event_type else {
            return vec![];
        };

        self.tool_sequence.push(name.clone());

        // Trim to max entries.
        if self.tool_sequence.len() > self.max_entries {
            let excess = self.tool_sequence.len() - self.max_entries;
            self.tool_sequence.drain(0..excess);
        }

        if let Some(cycle) = self.detect_cycle() {
            // Don't re-fire for the same cycle.
            if self.fired_for_cycle.as_ref() == Some(&cycle) {
                return vec![];
            }

            self.fired_for_cycle = Some(cycle.clone());

            let cycle_str = cycle.join(" → ");
            vec![Detection {
                pattern_name: "circular_reasoning".into(),
                severity: DetectionSeverity::Warning,
                action: DetectionAction::Alert,
                message: format!(
                    "Circular pattern detected: {} (repeated {}+ times)",
                    cycle_str, self.config.min_cycle_repetitions,
                ),
                details: HashMap::from([
                    ("cycle".into(), serde_json::json!(cycle)),
                    ("cycle_length".into(), serde_json::json!(cycle.len())),
                    (
                        "min_repetitions".into(),
                        serde_json::json!(self.config.min_cycle_repetitions),
                    ),
                ]),
                timestamp: event.timestamp,
            }]
        } else {
            // Clear fired_for_cycle if the new tool name is not part of the known cycle.
            if let Some(ref cycle) = self.fired_for_cycle {
                if !cycle.contains(name) {
                    self.fired_for_cycle = None;
                }
            }
            vec![]
        }
    }

    fn reset(&mut self) {
        self.tool_sequence.clear();
        self.fired_for_cycle = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::AgentEvent;

    fn tool_call(ts: u64, name: &str) -> AgentEvent {
        AgentEvent::at(
            ts,
            AgentEventType::ToolCall {
                name: name.into(),
                params_hash: 0,
                duration_ms: 50,
            },
        )
    }

    #[test]
    fn detects_ab_ab_cycle() {
        let mut det = CircularReasoningDetector::new(CircularReasoningConfig {
            max_cycle_length: 4,
            min_cycle_repetitions: 2,
        });

        assert!(det.process(&tool_call(1000, "search")).is_empty());
        assert!(det.process(&tool_call(2000, "read")).is_empty());
        assert!(det.process(&tool_call(3000, "search")).is_empty());

        let dets = det.process(&tool_call(4000, "read"));
        assert_eq!(dets.len(), 1);
        assert_eq!(dets[0].pattern_name, "circular_reasoning");
        // Normalized cycle: [read, search] (lexicographic order).
        assert!(dets[0].message.contains("read → search"));
    }

    #[test]
    fn detects_abc_abc_cycle() {
        let mut det = CircularReasoningDetector::new(CircularReasoningConfig {
            max_cycle_length: 4,
            min_cycle_repetitions: 2,
        });

        for name in ["search", "read", "edit", "search", "read"] {
            assert!(det.process(&tool_call(1000, name)).is_empty());
        }

        let dets = det.process(&tool_call(6000, "edit"));
        assert_eq!(dets.len(), 1);
        // Normalized cycle: [edit, search, read] (lexicographic order).
        assert!(dets[0].message.contains("edit → search → read"));
    }

    #[test]
    fn no_trigger_non_repeating() {
        let mut det = CircularReasoningDetector::new(CircularReasoningConfig::default());

        for (i, name) in ["a", "b", "c", "d", "e", "f", "g", "h"].iter().enumerate() {
            assert!(det
                .process(&tool_call(1000 * (i as u64 + 1), name))
                .is_empty());
        }
    }

    #[test]
    fn no_trigger_insufficient_repetitions() {
        let mut det = CircularReasoningDetector::new(CircularReasoningConfig {
            max_cycle_length: 4,
            min_cycle_repetitions: 3, // Need 3 reps
        });

        // Only 2 repetitions of A→B.
        for name in ["search", "read", "search", "read"] {
            assert!(det.process(&tool_call(1000, name)).is_empty());
        }
    }

    #[test]
    fn no_trigger_cycle_too_long() {
        let mut det = CircularReasoningDetector::new(CircularReasoningConfig {
            max_cycle_length: 2, // Only look for cycles up to length 2
            min_cycle_repetitions: 2,
        });

        // A→B→C→A→B→C is a cycle of length 3, but max is 2.
        for name in ["a", "b", "c", "a", "b", "c"] {
            assert!(det.process(&tool_call(1000, name)).is_empty());
        }
    }

    #[test]
    fn fires_only_once_per_cycle() {
        let mut det = CircularReasoningDetector::new(CircularReasoningConfig {
            max_cycle_length: 4,
            min_cycle_repetitions: 2,
        });

        // A→B→A→B — fires.
        det.process(&tool_call(1000, "a"));
        det.process(&tool_call(2000, "b"));
        det.process(&tool_call(3000, "a"));
        assert_eq!(det.process(&tool_call(4000, "b")).len(), 1);

        // A→B again — same cycle, should NOT fire.
        det.process(&tool_call(5000, "a"));
        assert!(det.process(&tool_call(6000, "b")).is_empty());
    }

    #[test]
    fn re_fires_after_cycle_breaks() {
        let mut det = CircularReasoningDetector::new(CircularReasoningConfig {
            max_cycle_length: 4,
            min_cycle_repetitions: 2,
        });

        // A→B→A→B — fires.
        det.process(&tool_call(1000, "a"));
        det.process(&tool_call(2000, "b"));
        det.process(&tool_call(3000, "a"));
        assert_eq!(det.process(&tool_call(4000, "b")).len(), 1);

        // Break the cycle.
        det.process(&tool_call(5000, "c"));

        // New cycle: A→B→A→B — should fire again.
        det.process(&tool_call(6000, "a"));
        det.process(&tool_call(7000, "b"));
        det.process(&tool_call(8000, "a"));
        assert_eq!(det.process(&tool_call(9000, "b")).len(), 1);
    }

    #[test]
    fn reset_clears_state() {
        let mut det = CircularReasoningDetector::new(CircularReasoningConfig::default());

        det.process(&tool_call(1000, "a"));
        det.process(&tool_call(2000, "b"));
        det.process(&tool_call(3000, "a"));
        det.reset();

        // After reset, need a full cycle again.
        assert!(det.process(&tool_call(4000, "b")).is_empty());
    }

    #[test]
    fn ignores_non_tool_call_events() {
        let mut det = CircularReasoningDetector::new(CircularReasoningConfig::default());
        let event = AgentEvent::at(
            1000,
            AgentEventType::FinalAnswer {
                content_length: 100,
            },
        );
        assert!(det.process(&event).is_empty());
    }
}
