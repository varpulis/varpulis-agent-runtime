use std::collections::{HashMap, VecDeque};

use crate::event::{AgentEvent, AgentEventType};
use crate::pattern::detector::{Detection, DetectionSeverity, PatternDetector};

/// Configuration for the token velocity spike detector.
#[derive(Debug, Clone)]
pub struct TokenVelocityConfig {
    /// Number of historical steps to use as baseline.
    pub baseline_window_steps: u32,
    /// Multiplier above baseline average that triggers a spike alert.
    pub spike_multiplier: f64,
}

impl Default for TokenVelocityConfig {
    fn default() -> Self {
        Self {
            baseline_window_steps: 5,
            spike_multiplier: 2.0,
        }
    }
}

/// Detects sudden spikes in token consumption rate per step,
/// indicating the agent is losing efficiency.
pub struct TokenVelocitySpikeDetector {
    config: TokenVelocityConfig,
    /// Tokens accumulated during the current step.
    current_step_tokens: u32,
    /// Whether we're between a StepStart and StepEnd.
    in_step: bool,
    /// Ring buffer of tokens per completed step.
    step_history: VecDeque<u32>,
}

impl TokenVelocitySpikeDetector {
    pub fn new(config: TokenVelocityConfig) -> Self {
        Self {
            config,
            current_step_tokens: 0,
            in_step: false,
            step_history: VecDeque::new(),
        }
    }
}

impl PatternDetector for TokenVelocitySpikeDetector {
    fn name(&self) -> &str {
        "token_velocity_spike"
    }

    fn process(&mut self, event: &AgentEvent) -> Vec<Detection> {
        match &event.event_type {
            AgentEventType::StepStart { .. } => {
                self.in_step = true;
                self.current_step_tokens = 0;
                vec![]
            }
            AgentEventType::LlmCall {
                input_tokens,
                output_tokens,
                ..
            } => {
                if self.in_step {
                    self.current_step_tokens += input_tokens + output_tokens;
                }
                vec![]
            }
            AgentEventType::StepEnd { .. } => {
                if !self.in_step {
                    return vec![];
                }
                self.in_step = false;

                let current = self.current_step_tokens;
                self.step_history.push_back(current);

                // Keep only baseline + 1 entries (baseline window + current).
                let max_entries = self.config.baseline_window_steps as usize + 1;
                while self.step_history.len() > max_entries {
                    self.step_history.pop_front();
                }

                // Need at least baseline_window + 1 entries to compare.
                if self.step_history.len() <= self.config.baseline_window_steps as usize {
                    return vec![];
                }

                // Baseline is everything except the last entry.
                let baseline_count = self.step_history.len() - 1;
                let baseline_sum: u32 = self.step_history.iter().take(baseline_count).sum();
                let baseline_avg = baseline_sum as f64 / baseline_count as f64;

                if baseline_avg > 0.0
                    && current as f64 > baseline_avg * self.config.spike_multiplier
                {
                    vec![Detection {
                        pattern_name: "token_velocity_spike".into(),
                        severity: DetectionSeverity::Warning,
                        message: format!(
                            "Token spike: {} tokens this step vs {:.0} avg baseline ({:.1}x)",
                            current,
                            baseline_avg,
                            current as f64 / baseline_avg,
                        ),
                        details: HashMap::from([
                            ("current_tokens".into(), serde_json::json!(current)),
                            ("baseline_avg".into(), serde_json::json!(baseline_avg)),
                            (
                                "multiplier".into(),
                                serde_json::json!(current as f64 / baseline_avg),
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
        self.current_step_tokens = 0;
        self.in_step = false;
        self.step_history.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::AgentEvent;

    fn step_start(ts: u64, step: u32) -> AgentEvent {
        AgentEvent::at(ts, AgentEventType::StepStart { step_number: step })
    }

    fn step_end(ts: u64, step: u32) -> AgentEvent {
        AgentEvent::at(
            ts,
            AgentEventType::StepEnd {
                step_number: step,
                produced_output: false,
            },
        )
    }

    fn llm_call(ts: u64, input: u32, output: u32) -> AgentEvent {
        AgentEvent::at(
            ts,
            AgentEventType::LlmCall {
                model: "test".into(),
                input_tokens: input,
                output_tokens: output,
                cost_usd: 0.01,
            },
        )
    }

    /// Helper to run a complete step with a given token count.
    fn run_step(
        det: &mut TokenVelocitySpikeDetector,
        ts: u64,
        step: u32,
        tokens: u32,
    ) -> Vec<Detection> {
        det.process(&step_start(ts, step));
        det.process(&llm_call(ts + 100, tokens / 2, tokens / 2));
        det.process(&step_end(ts + 200, step))
    }

    #[test]
    fn no_trigger_during_baseline_buildup() {
        let mut det = TokenVelocitySpikeDetector::new(TokenVelocityConfig {
            baseline_window_steps: 3,
            spike_multiplier: 2.0,
        });

        // First 3 steps build the baseline — no detection possible.
        for i in 0..3 {
            let dets = run_step(&mut det, 1000 + i * 1000, i as u32, 500);
            assert!(dets.is_empty(), "step {} should not trigger", i);
        }
    }

    #[test]
    fn triggers_on_spike() {
        let mut det = TokenVelocitySpikeDetector::new(TokenVelocityConfig {
            baseline_window_steps: 3,
            spike_multiplier: 2.0,
        });

        // Baseline: 3 steps at ~500 tokens each.
        for i in 0..3 {
            run_step(&mut det, 1000 + i * 1000, i as u32, 500);
        }

        // Spike: 1500 tokens = 3x baseline (above 2x threshold).
        let dets = run_step(&mut det, 10000, 3, 1500);
        assert_eq!(dets.len(), 1);
        assert_eq!(dets[0].pattern_name, "token_velocity_spike");
    }

    #[test]
    fn no_trigger_within_normal_range() {
        let mut det = TokenVelocitySpikeDetector::new(TokenVelocityConfig {
            baseline_window_steps: 3,
            spike_multiplier: 2.0,
        });

        for i in 0..3 {
            run_step(&mut det, 1000 + i * 1000, i as u32, 500);
        }

        // 800 tokens = 1.6x baseline, below 2x threshold.
        let dets = run_step(&mut det, 10000, 3, 800);
        assert!(dets.is_empty());
    }

    #[test]
    fn baseline_adapts_as_window_slides() {
        let mut det = TokenVelocitySpikeDetector::new(TokenVelocityConfig {
            baseline_window_steps: 3,
            spike_multiplier: 2.0,
        });

        // Initial baseline: 500 tokens.
        for i in 0..3 {
            run_step(&mut det, 1000 + i * 1000, i as u32, 500);
        }

        // Gradually increase — each step becomes the new baseline.
        for i in 3..6 {
            run_step(&mut det, 1000 + i * 1000, i as u32, 1000);
        }

        // Now baseline is ~1000. A step at 1500 = 1.5x, should NOT trigger (< 2x).
        let dets = run_step(&mut det, 20000, 6, 1500);
        assert!(dets.is_empty());
    }

    #[test]
    fn zero_baseline_no_division_by_zero() {
        let mut det = TokenVelocitySpikeDetector::new(TokenVelocityConfig {
            baseline_window_steps: 3,
            spike_multiplier: 2.0,
        });

        // 3 steps with 0 tokens.
        for i in 0..3 {
            run_step(&mut det, 1000 + i * 1000, i as u32, 0);
        }

        // A step with tokens should not crash (baseline_avg = 0).
        let dets = run_step(&mut det, 10000, 3, 1000);
        assert!(dets.is_empty());
    }

    #[test]
    fn ignores_llm_calls_outside_step() {
        let mut det = TokenVelocitySpikeDetector::new(TokenVelocityConfig {
            baseline_window_steps: 3,
            spike_multiplier: 2.0,
        });

        // LLM call without being in a step — should be ignored.
        det.process(&llm_call(1000, 5000, 5000));

        // Normal steps.
        for i in 0..3 {
            run_step(&mut det, 2000 + i * 1000, i as u32, 500);
        }

        // Should not trigger because the 10000-token call was outside a step.
        let dets = run_step(&mut det, 10000, 3, 800);
        assert!(dets.is_empty());
    }

    #[test]
    fn reset_clears_state() {
        let mut det = TokenVelocitySpikeDetector::new(TokenVelocityConfig {
            baseline_window_steps: 3,
            spike_multiplier: 2.0,
        });

        for i in 0..3 {
            run_step(&mut det, 1000 + i * 1000, i as u32, 500);
        }
        det.reset();

        // After reset, need to rebuild baseline — no detection.
        for i in 0..3 {
            let dets = run_step(&mut det, 10000 + i * 1000, i as u32, 5000);
            assert!(dets.is_empty());
        }
    }
}
