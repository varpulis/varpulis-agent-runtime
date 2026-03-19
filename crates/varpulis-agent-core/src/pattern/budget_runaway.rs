use std::collections::HashMap;

use crate::event::{AgentEvent, AgentEventType};
use crate::pattern::detector::{Detection, DetectionSeverity, PatternDetector};

/// Configuration for the budget runaway detector.
#[derive(Debug, Clone)]
pub struct BudgetRunawayConfig {
    /// Maximum cost in USD within the window before alerting.
    pub max_cost_usd: f64,
    /// Maximum total tokens within the window before alerting.
    pub max_tokens: u32,
    /// Sliding window size in seconds.
    pub window_seconds: u64,
}

impl Default for BudgetRunawayConfig {
    fn default() -> Self {
        Self {
            max_cost_usd: 1.00,
            max_tokens: 100_000,
            window_seconds: 60,
        }
    }
}

/// Detects when cumulative LLM cost or token usage exceeds thresholds
/// within a sliding time window.
///
/// Fires a Warning at 80% of the threshold and an Error at 100%.
pub struct BudgetRunawayDetector {
    config: BudgetRunawayConfig,
    /// Recent LLM calls: (timestamp_ms, cost_usd, total_tokens).
    recent_calls: Vec<(u64, f64, u32)>,
    fired_warning: bool,
    fired_error: bool,
}

impl BudgetRunawayDetector {
    pub fn new(config: BudgetRunawayConfig) -> Self {
        Self {
            config,
            recent_calls: Vec::new(),
            fired_warning: false,
            fired_error: false,
        }
    }

    fn window_totals(&self) -> (f64, u32) {
        let total_cost: f64 = self.recent_calls.iter().map(|(_, c, _)| c).sum();
        let total_tokens: u32 = self.recent_calls.iter().map(|(_, _, t)| t).sum();
        (total_cost, total_tokens)
    }
}

impl PatternDetector for BudgetRunawayDetector {
    fn name(&self) -> &str {
        "budget_runaway"
    }

    fn process(&mut self, event: &AgentEvent) -> Vec<Detection> {
        let AgentEventType::LlmCall {
            input_tokens,
            output_tokens,
            cost_usd,
            ..
        } = &event.event_type
        else {
            return vec![];
        };

        let total_tokens = input_tokens + output_tokens;
        self.recent_calls
            .push((event.timestamp, *cost_usd, total_tokens));

        // Evict entries outside the window.
        let window_ms = self.config.window_seconds * 1000;
        let cutoff = event.timestamp.saturating_sub(window_ms);
        self.recent_calls.retain(|(ts, _, _)| *ts >= cutoff);

        let (total_cost, total_tok) = self.window_totals();

        // Reset fired flags if we've dropped below 80%.
        let cost_ratio = total_cost / self.config.max_cost_usd;
        let token_ratio = total_tok as f64 / self.config.max_tokens as f64;

        if cost_ratio < 0.8 && token_ratio < 0.8 {
            self.fired_warning = false;
            self.fired_error = false;
        }

        let at_error = cost_ratio >= 1.0 || token_ratio >= 1.0;
        let at_warning = cost_ratio >= 0.8 || token_ratio >= 0.8;

        if at_error && !self.fired_error {
            self.fired_error = true;
            self.fired_warning = true;
            vec![Detection {
                pattern_name: "budget_runaway".into(),
                severity: DetectionSeverity::Error,
                message: format!(
                    "Budget exceeded: ${:.4} / ${:.2} cost, {} / {} tokens in {}s window",
                    total_cost,
                    self.config.max_cost_usd,
                    total_tok,
                    self.config.max_tokens,
                    self.config.window_seconds,
                ),
                details: HashMap::from([
                    ("total_cost_usd".into(), serde_json::json!(total_cost)),
                    (
                        "max_cost_usd".into(),
                        serde_json::json!(self.config.max_cost_usd),
                    ),
                    ("total_tokens".into(), serde_json::json!(total_tok)),
                    (
                        "max_tokens".into(),
                        serde_json::json!(self.config.max_tokens),
                    ),
                    (
                        "window_seconds".into(),
                        serde_json::json!(self.config.window_seconds),
                    ),
                ]),
                timestamp: event.timestamp,
            }]
        } else if at_warning && !self.fired_warning {
            self.fired_warning = true;
            vec![Detection {
                pattern_name: "budget_runaway".into(),
                severity: DetectionSeverity::Warning,
                message: format!(
                    "Budget warning (80%): ${:.4} / ${:.2} cost, {} / {} tokens in {}s window",
                    total_cost,
                    self.config.max_cost_usd,
                    total_tok,
                    self.config.max_tokens,
                    self.config.window_seconds,
                ),
                details: HashMap::from([
                    ("total_cost_usd".into(), serde_json::json!(total_cost)),
                    (
                        "max_cost_usd".into(),
                        serde_json::json!(self.config.max_cost_usd),
                    ),
                    ("total_tokens".into(), serde_json::json!(total_tok)),
                    (
                        "max_tokens".into(),
                        serde_json::json!(self.config.max_tokens),
                    ),
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
        self.fired_warning = false;
        self.fired_error = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::AgentEvent;

    fn llm_call(ts: u64, cost: f64, input: u32, output: u32) -> AgentEvent {
        AgentEvent::at(
            ts,
            AgentEventType::LlmCall {
                model: "test-model".into(),
                input_tokens: input,
                output_tokens: output,
                cost_usd: cost,
            },
        )
    }

    #[test]
    fn warning_at_80_percent_cost() {
        let mut det = BudgetRunawayDetector::new(BudgetRunawayConfig {
            max_cost_usd: 1.00,
            max_tokens: 999_999,
            window_seconds: 60,
        });

        // 4 calls at $0.20 each = $0.80 (80%)
        for i in 0..3 {
            assert!(det
                .process(&llm_call(1000 + i * 1000, 0.20, 100, 50))
                .is_empty());
        }
        let dets = det.process(&llm_call(4000, 0.20, 100, 50));
        assert_eq!(dets.len(), 1);
        assert_eq!(dets[0].severity, DetectionSeverity::Warning);
    }

    #[test]
    fn error_at_100_percent_cost() {
        let mut det = BudgetRunawayDetector::new(BudgetRunawayConfig {
            max_cost_usd: 1.00,
            max_tokens: 999_999,
            window_seconds: 60,
        });

        // 5 calls at $0.20 = $1.00 (100%)
        for i in 0..4 {
            det.process(&llm_call(1000 + i * 1000, 0.20, 100, 50));
        }
        let dets = det.process(&llm_call(5000, 0.20, 100, 50));
        assert_eq!(dets.len(), 1);
        assert_eq!(dets[0].severity, DetectionSeverity::Error);
    }

    #[test]
    fn warning_at_80_percent_tokens() {
        let mut det = BudgetRunawayDetector::new(BudgetRunawayConfig {
            max_cost_usd: 999.0,
            max_tokens: 1000,
            window_seconds: 60,
        });

        // 800 tokens = 80%
        for i in 0..3 {
            assert!(det
                .process(&llm_call(1000 + i * 1000, 0.001, 100, 100))
                .is_empty());
        }
        let dets = det.process(&llm_call(4000, 0.001, 100, 100));
        assert_eq!(dets.len(), 1);
        assert_eq!(dets[0].severity, DetectionSeverity::Warning);
    }

    #[test]
    fn no_trigger_under_threshold() {
        let mut det = BudgetRunawayDetector::new(BudgetRunawayConfig {
            max_cost_usd: 1.00,
            max_tokens: 100_000,
            window_seconds: 60,
        });

        // 3 calls at $0.10 = $0.30 (30%)
        for i in 0..3 {
            assert!(det
                .process(&llm_call(1000 + i * 1000, 0.10, 100, 50))
                .is_empty());
        }
    }

    #[test]
    fn window_eviction_resets_flags() {
        let mut det = BudgetRunawayDetector::new(BudgetRunawayConfig {
            max_cost_usd: 1.00,
            max_tokens: 999_999,
            window_seconds: 5,
        });

        // Trigger warning
        for i in 0..4 {
            det.process(&llm_call(1000 + i * 1000, 0.20, 100, 50));
        }
        // After window expires, a new burst should trigger again
        for i in 0..3 {
            det.process(&llm_call(20000 + i * 1000, 0.20, 100, 50));
        }
        let dets = det.process(&llm_call(23000, 0.20, 100, 50));
        assert_eq!(dets.len(), 1);
        assert_eq!(dets[0].severity, DetectionSeverity::Warning);
    }

    #[test]
    fn ignores_non_llm_events() {
        let mut det = BudgetRunawayDetector::new(BudgetRunawayConfig::default());
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
        let mut det = BudgetRunawayDetector::new(BudgetRunawayConfig {
            max_cost_usd: 1.00,
            max_tokens: 999_999,
            window_seconds: 60,
        });

        for i in 0..4 {
            det.process(&llm_call(1000 + i * 1000, 0.20, 100, 50));
        }
        det.reset();

        // After reset, need 4 more calls to hit 80% again
        for i in 0..3 {
            assert!(det
                .process(&llm_call(10000 + i * 1000, 0.20, 100, 50))
                .is_empty());
        }
        let dets = det.process(&llm_call(13000, 0.20, 100, 50));
        assert_eq!(dets.len(), 1);
    }

    #[test]
    fn fires_warning_then_error() {
        let mut det = BudgetRunawayDetector::new(BudgetRunawayConfig {
            max_cost_usd: 1.00,
            max_tokens: 999_999,
            window_seconds: 60,
        });

        // Push to 80% -> warning
        for i in 0..3 {
            det.process(&llm_call(1000 + i * 1000, 0.20, 100, 50));
        }
        let dets = det.process(&llm_call(4000, 0.20, 100, 50));
        assert_eq!(dets.len(), 1);
        assert_eq!(dets[0].severity, DetectionSeverity::Warning);

        // Push to 100% -> error
        let dets = det.process(&llm_call(5000, 0.20, 100, 50));
        assert_eq!(dets.len(), 1);
        assert_eq!(dets[0].severity, DetectionSeverity::Error);

        // No more fires until reset
        assert!(det.process(&llm_call(6000, 0.20, 100, 50)).is_empty());
    }
}
