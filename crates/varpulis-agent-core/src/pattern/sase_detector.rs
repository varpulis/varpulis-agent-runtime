//! SASE-backed pattern detectors using the Varpulis CEP engine.
//!
//! Each agent behavioral pattern is expressed as a SASE+ pattern with
//! Kleene closure, temporal windows, and cross-event predicates.

use std::collections::HashMap;
use std::time::Duration;

use varpulis_sase::{MatchResult, PatternBuilder, Predicate, SaseEngine, SasePattern};

use crate::event::AgentEvent;
use crate::pattern::detector::{Detection, DetectionAction, DetectionSeverity, PatternDetector};

type MatchHandler = Box<dyn Fn(&[MatchResult], &AgentEvent) -> Vec<Detection> + Send + Sync>;
type EventFilter = Box<dyn Fn(&AgentEvent) -> bool + Send + Sync>;

/// A pattern detector backed by a Varpulis SASE engine.
///
/// Translates AgentEvents into CEP events, feeds them through the SASE
/// NFA-based pattern matcher, and converts match results into Detections.
pub struct SaseDetector {
    name: String,
    engine: SaseEngine,
    pattern: SasePattern,
    /// Pre-filter: only pass events where this returns true to the SASE engine.
    event_filter: EventFilter,
    match_handler: MatchHandler,
}

impl SaseDetector {
    fn new(
        name: &str,
        pattern: SasePattern,
        relevant_types: Vec<&str>,
        handler: impl Fn(&[MatchResult], &AgentEvent) -> Vec<Detection> + Send + Sync + 'static,
    ) -> Self {
        let types: Vec<String> = relevant_types.into_iter().map(String::from).collect();
        Self::new_with_filter(
            name,
            pattern,
            move |event| {
                let event_type_name = event.event_type_name();
                types.is_empty() || types.iter().any(|t| t == event_type_name)
            },
            handler,
        )
    }

    fn new_with_filter(
        name: &str,
        pattern: SasePattern,
        filter: impl Fn(&AgentEvent) -> bool + Send + Sync + 'static,
        handler: impl Fn(&[MatchResult], &AgentEvent) -> Vec<Detection> + Send + Sync + 'static,
    ) -> Self {
        let engine = SaseEngine::new(pattern.clone());
        Self {
            name: name.to_string(),
            engine,
            pattern,
            event_filter: Box::new(filter),
            match_handler: Box::new(handler),
        }
    }

    // -----------------------------------------------------------------------
    // Tier 1: Pure SASE patterns (Kleene closure showcase)
    // -----------------------------------------------------------------------

    /// Retry Storm: SEQ(ToolCall, ToolCall+ WHERE same name & params_hash) WITHIN window
    ///
    /// Uses Kleene+ to capture all repeated identical tool calls in one match.
    pub fn retry_storm(config: &super::RetryStormConfig) -> Self {
        let min_reps = config.min_repetitions;
        let kill_threshold = config.kill_threshold;

        // SEQ(first: ToolCall, repeats: ToolCall+ WHERE name==first.name AND params_hash==first.params_hash)
        let pattern = PatternBuilder::within(
            PatternBuilder::seq(vec![
                SasePattern::Event {
                    event_type: "ToolCall".to_string(),
                    predicate: None,
                    alias: Some("first".to_string()),
                },
                PatternBuilder::one_or_more(SasePattern::Event {
                    event_type: "ToolCall".to_string(),
                    predicate: Some(Predicate::And(
                        Box::new(PatternBuilder::field_ref_eq("name", "first", "name")),
                        Box::new(PatternBuilder::field_ref_eq(
                            "params_hash",
                            "first",
                            "params_hash",
                        )),
                    )),
                    alias: Some("repeat".to_string()),
                }),
            ]),
            Duration::from_secs(config.window_seconds),
        );

        Self::new(
            "retry_storm",
            pattern,
            vec!["ToolCall"],
            move |matches, event| {
                let mut detections = Vec::new();
                for m in matches {
                    // Count = first + repeats in the stack
                    let count = m.stack.len() as u32;
                    if count >= min_reps {
                        let tool_name = m
                            .captured
                            .get("first")
                            .and_then(|e| e.get_str("name"))
                            .unwrap_or("unknown");
                        let should_kill = kill_threshold.is_some_and(|t| count >= t);

                        detections.push(Detection {
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
                                "Tool '{}' called {} times with identical params (Kleene+ match)",
                                tool_name, count
                            ),
                            details: HashMap::from([
                                ("tool_name".into(), serde_json::json!(tool_name)),
                                ("count".into(), serde_json::json!(count)),
                                ("kleene_events".into(), serde_json::json!(m.stack.len())),
                            ]),
                            timestamp: event.timestamp,
                        });
                    }
                }
                detections
            },
        )
    }

    /// Error Spiral: ToolResult{success=false}+ WITHIN window
    ///
    /// Uses Kleene+ to capture all consecutive failures in one match.
    pub fn error_spiral(config: &super::ErrorSpiralConfig) -> Self {
        let min_errors = config.min_error_count;
        let kill_threshold = config.kill_threshold;

        // ToolResult{success==false}+ within window
        let pattern = PatternBuilder::within(
            PatternBuilder::one_or_more(SasePattern::Event {
                event_type: "ToolResult".to_string(),
                predicate: Some(PatternBuilder::field_eq(
                    "success",
                    varpulis_core::Value::Bool(false),
                )),
                alias: Some("error".to_string()),
            }),
            Duration::from_secs(config.window_seconds),
        );

        Self::new_with_filter(
            "error_spiral",
            pattern,
            |event| {
                matches!(
                    &event.event_type,
                    crate::event::AgentEventType::ToolResult { success: false, .. }
                )
            },
            move |matches, event| {
                let mut detections = Vec::new();
                for m in matches {
                    let count = m.stack.len() as u32;
                    if count >= min_errors {
                        let should_kill = kill_threshold.is_some_and(|t| count >= t);
                        detections.push(Detection {
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
                            message: format!("{} tool errors in Kleene+ match", count),
                            details: HashMap::from([(
                                "error_count".into(),
                                serde_json::json!(count),
                            )]),
                            timestamp: event.timestamp,
                        });
                    }
                }
                detections
            },
        )
    }

    // -----------------------------------------------------------------------
    // Tier 2: SASE + post-match aggregation
    // -----------------------------------------------------------------------

    /// Budget Runaway: LlmCall+ WITHIN window, post-match sum of cost/tokens.
    ///
    /// Uses Kleene+ to capture all LLM calls, then aggregates cost and tokens.
    pub fn budget_runaway(config: &super::BudgetRunawayConfig) -> Self {
        let max_cost = config.max_cost_usd;
        let max_tokens = config.max_tokens;

        // LlmCall+ within window
        let pattern = PatternBuilder::within(
            PatternBuilder::one_or_more(SasePattern::Event {
                event_type: "LlmCall".to_string(),
                predicate: None,
                alias: Some("call".to_string()),
            }),
            Duration::from_secs(config.window_seconds),
        );

        Self::new(
            "budget_runaway",
            pattern,
            vec!["LlmCall"],
            move |matches, event| {
                let mut detections = Vec::new();
                for m in matches {
                    // Aggregate cost and tokens from all captured LlmCall events.
                    let mut total_cost = 0.0_f64;
                    let mut total_tokens = 0_u32;
                    for entry in &m.stack {
                        if let Some(cost) = entry.event.get_float("cost_usd") {
                            total_cost += cost;
                        }
                        let input = entry.event.get_int("input_tokens").unwrap_or(0) as u32;
                        let output = entry.event.get_int("output_tokens").unwrap_or(0) as u32;
                        total_tokens += input + output;
                    }

                    let cost_ratio = total_cost / max_cost;
                    let token_ratio = total_tokens as f64 / max_tokens as f64;
                    let at_error = cost_ratio >= 1.0 || token_ratio >= 1.0;
                    let at_warning = cost_ratio >= 0.8 || token_ratio >= 0.8;

                    if at_error {
                        detections.push(Detection {
                        pattern_name: "budget_runaway".into(),
                        severity: DetectionSeverity::Error,
                        action: DetectionAction::Kill,
                        message: format!(
                            "Budget exceeded: ${:.4} / ${:.2}, {} / {} tokens (Kleene+ aggregation over {} calls)",
                            total_cost, max_cost, total_tokens, max_tokens, m.stack.len()
                        ),
                        details: HashMap::from([
                            ("total_cost_usd".into(), serde_json::json!(total_cost)),
                            ("total_tokens".into(), serde_json::json!(total_tokens)),
                            ("call_count".into(), serde_json::json!(m.stack.len())),
                        ]),
                        timestamp: event.timestamp,
                    });
                    } else if at_warning {
                        detections.push(Detection {
                            pattern_name: "budget_runaway".into(),
                            severity: DetectionSeverity::Warning,
                            action: DetectionAction::Alert,
                            message: format!(
                                "Budget warning (80%): ${:.4} / ${:.2}, {} / {} tokens",
                                total_cost, max_cost, total_tokens, max_tokens
                            ),
                            details: HashMap::from([
                                ("total_cost_usd".into(), serde_json::json!(total_cost)),
                                ("total_tokens".into(), serde_json::json!(total_tokens)),
                                ("call_count".into(), serde_json::json!(m.stack.len())),
                            ]),
                            timestamp: event.timestamp,
                        });
                    }
                }
                detections
            },
        )
    }

    /// Stuck Agent: SEQ(StepEnd{produced_output=false}+) WITHIN window
    ///
    /// Uses Kleene+ over unproductive steps, with global negation on
    /// FinalAnswer and StepEnd{produced_output=true} to reset on output.
    pub fn stuck_agent(config: &super::StuckAgentConfig) -> Self {
        let max_steps = config.max_steps_without_output;
        let kill_threshold = config.kill_threshold;

        // StepEnd{produced_output==false}+ within window
        let pattern = PatternBuilder::within(
            PatternBuilder::one_or_more(SasePattern::Event {
                event_type: "StepEnd".to_string(),
                predicate: Some(PatternBuilder::field_eq(
                    "produced_output",
                    varpulis_core::Value::Bool(false),
                )),
                alias: Some("step".to_string()),
            }),
            Duration::from_secs(config.max_time_without_output_seconds),
        );

        // Build engine with global negations to reset on output events.
        let mut engine = SaseEngine::new(pattern.clone());
        engine.add_negation("FinalAnswer".to_string(), None);
        engine.add_negation(
            "StepEnd".to_string(),
            Some(PatternBuilder::field_eq(
                "produced_output",
                varpulis_core::Value::Bool(true),
            )),
        );

        Self {
            name: "stuck_agent".to_string(),
            engine,
            pattern,
            event_filter: Box::new(|event| {
                matches!(
                    &event.event_type,
                    crate::event::AgentEventType::StepEnd { .. }
                        | crate::event::AgentEventType::FinalAnswer { .. }
                )
            }),
            match_handler: Box::new(move |matches, event| {
                let mut detections = Vec::new();
                for m in matches {
                    let count = m.stack.len() as u32;
                    if count >= max_steps {
                        let should_kill = kill_threshold.is_some_and(|t| count >= t);
                        detections.push(Detection {
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
                            message: format!(
                                "Agent stuck: {} steps without output (Kleene+ match)",
                                count
                            ),
                            details: HashMap::from([(
                                "steps_since_output".into(),
                                serde_json::json!(count),
                            )]),
                            timestamp: event.timestamp,
                        });
                    }
                }
                detections
            }),
        }
    }

    /// Targeted Failure: ToolResult{success=false}+ WITHIN window, post-match
    /// grouping by failure_target metadata.
    ///
    /// Detects when a session repeatedly fails on the same target (test, file,
    /// endpoint). The `failure_target` field is expected in event metadata,
    /// set by the adapter layer. Emits a detection per distinct target that
    /// exceeds the threshold.
    pub fn targeted_failure(config: &super::TargetedFailureConfig) -> Self {
        let min_failures = config.min_failures;

        // ToolResult{success==false}+ within window
        let pattern = PatternBuilder::within(
            PatternBuilder::one_or_more(SasePattern::Event {
                event_type: "ToolResult".to_string(),
                predicate: Some(PatternBuilder::field_eq(
                    "success",
                    varpulis_core::Value::Bool(false),
                )),
                alias: Some("failure".to_string()),
            }),
            Duration::from_secs(config.window_seconds),
        );

        Self::new_with_filter(
            "targeted_failure",
            pattern,
            |event| {
                matches!(
                    &event.event_type,
                    crate::event::AgentEventType::ToolResult { success: false, .. }
                )
            },
            move |matches, event| {
                let mut detections = Vec::new();
                for m in matches {
                    // Group failures by failure_target from metadata.
                    // Each captured event in the stack may have a failure_target field.
                    let mut target_counts: HashMap<String, u32> = HashMap::new();
                    for entry in &m.stack {
                        if let Some(target) = entry.event.get_str("failure_target") {
                            if !target.is_empty() {
                                *target_counts.entry(target.to_string()).or_insert(0) += 1;
                            }
                        }
                    }

                    // Also check the current event's metadata
                    let current_target = event
                        .metadata
                        .get("failure_target")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");

                    // Emit a detection for each target that exceeds the threshold
                    for (target, count) in &target_counts {
                        if *count >= min_failures {
                            detections.push(Detection {
                                pattern_name: "targeted_failure".into(),
                                severity: DetectionSeverity::Warning,
                                action: DetectionAction::Alert,
                                message: format!(
                                    "Repeated failure on target '{}': {} failures in window (Kleene+ match)",
                                    target, count
                                ),
                                details: HashMap::from([
                                    ("failure_target".into(), serde_json::json!(target)),
                                    ("failure_count".into(), serde_json::json!(count)),
                                    ("total_failures".into(), serde_json::json!(m.stack.len())),
                                ]),
                                timestamp: event.timestamp,
                            });
                        }
                    }

                    // If no targets had metadata but we still have enough failures,
                    // emit a generic detection so the adapter can still correlate
                    if target_counts.is_empty() && m.stack.len() as u32 >= min_failures {
                        let generic_target = if !current_target.is_empty() {
                            current_target.to_string()
                        } else {
                            // Fall back to error message from the current event
                            match &event.event_type {
                                crate::event::AgentEventType::ToolResult { error: Some(e), .. } => {
                                    e.clone()
                                }
                                _ => "unknown".to_string(),
                            }
                        };
                        detections.push(Detection {
                            pattern_name: "targeted_failure".into(),
                            severity: DetectionSeverity::Warning,
                            action: DetectionAction::Alert,
                            message: format!(
                                "Repeated failure on target '{}': {} failures in window",
                                generic_target,
                                m.stack.len()
                            ),
                            details: HashMap::from([
                                ("failure_target".into(), serde_json::json!(generic_target)),
                                ("failure_count".into(), serde_json::json!(m.stack.len())),
                            ]),
                            timestamp: event.timestamp,
                        });
                    }
                }
                detections
            },
        )
    }

    /// Circular Reasoning: SEQ(ToolCall as a, ToolCall{name!=a.name} as b,
    ///                         ToolCall{name==a.name}, ToolCall{name==b.name})
    ///
    /// Detects A→B→A→B cycles using cross-event predicates.
    pub fn circular_reasoning(config: &super::CircularReasoningConfig) -> Self {
        let _min_reps = config.min_cycle_repetitions;

        // SEQ(a: ToolCall, b: ToolCall{name!=a.name}, ToolCall{name==a.name}, ToolCall{name==b.name})
        let pattern = PatternBuilder::seq(vec![
            SasePattern::Event {
                event_type: "ToolCall".to_string(),
                predicate: None,
                alias: Some("a".to_string()),
            },
            SasePattern::Event {
                event_type: "ToolCall".to_string(),
                predicate: Some(Predicate::CompareRef {
                    field: "name".to_string(),
                    op: varpulis_sase::CompareOp::NotEq,
                    ref_alias: "a".to_string(),
                    ref_field: "name".to_string(),
                }),
                alias: Some("b".to_string()),
            },
            SasePattern::Event {
                event_type: "ToolCall".to_string(),
                predicate: Some(PatternBuilder::field_ref_eq("name", "a", "name")),
                alias: Some("a2".to_string()),
            },
            SasePattern::Event {
                event_type: "ToolCall".to_string(),
                predicate: Some(PatternBuilder::field_ref_eq("name", "b", "name")),
                alias: Some("b2".to_string()),
            },
        ]);

        Self::new(
            "circular_reasoning",
            pattern,
            vec!["ToolCall"],
            move |matches, event| {
                let mut detections = Vec::new();
                for m in matches {
                    let tool_a = m
                        .captured
                        .get("a")
                        .and_then(|e| e.get_str("name"))
                        .unwrap_or("?");
                    let tool_b = m
                        .captured
                        .get("b")
                        .and_then(|e| e.get_str("name"))
                        .unwrap_or("?");

                    detections.push(Detection {
                        pattern_name: "circular_reasoning".into(),
                        severity: DetectionSeverity::Warning,
                        action: DetectionAction::Alert,
                        message: format!(
                            "Circular pattern: {} → {} → {} → {} (SASE sequence match)",
                            tool_a, tool_b, tool_a, tool_b
                        ),
                        details: HashMap::from([
                            ("cycle".into(), serde_json::json!([tool_a, tool_b])),
                            ("cycle_length".into(), serde_json::json!(2)),
                        ]),
                        timestamp: event.timestamp,
                    });
                }
                detections
            },
        )
    }
}

impl PatternDetector for SaseDetector {
    fn name(&self) -> &str {
        &self.name
    }

    fn process(&mut self, event: &AgentEvent) -> Vec<Detection> {
        // Pre-filter: skip irrelevant events before feeding to SASE engine.
        if !(self.event_filter)(event) {
            return vec![];
        }
        let cep_event = event.to_cep_event();
        let matches = self.engine.process(&cep_event);
        if matches.is_empty() {
            return vec![];
        }
        (self.match_handler)(&matches, event)
    }

    fn reset(&mut self) {
        self.engine = SaseEngine::new(self.pattern.clone());
    }
}

/// A generic VPL-defined pattern detector.
/// Unlike `SaseDetector` (which has per-pattern event filtering and custom match handlers),
/// `VplDetector` accepts all events and converts every match into a detection.
pub struct VplDetector {
    name: String,
    engine: SaseEngine,
    pattern: SasePattern,
}

impl VplDetector {
    pub fn new(name: String, engine: SaseEngine) -> Self {
        let pattern = SasePattern::Event {
            event_type: String::new(),
            predicate: None,
            alias: None,
        }; // placeholder — we don't need to reset VPL detectors typically
        Self {
            name,
            engine,
            pattern,
        }
    }
}

impl PatternDetector for VplDetector {
    fn name(&self) -> &str {
        &self.name
    }

    fn process(&mut self, event: &AgentEvent) -> Vec<Detection> {
        let cep_event = event.to_cep_event();
        let matches = self.engine.process(&cep_event);
        let mut detections = Vec::new();
        for m in matches {
            detections.push(Detection {
                pattern_name: self.name.clone(),
                severity: DetectionSeverity::Warning,
                action: DetectionAction::Alert,
                message: format!(
                    "VPL pattern '{}' matched ({} events in sequence)",
                    self.name,
                    m.stack.len()
                ),
                details: HashMap::from([
                    ("events_matched".into(), serde_json::json!(m.stack.len())),
                    (
                        "duration_ms".into(),
                        serde_json::json!(m.duration.as_millis()),
                    ),
                ]),
                timestamp: event.timestamp,
            });
        }
        detections
    }

    fn reset(&mut self) {
        // VplDetector doesn't store the original pattern for reset.
        // In practice, VPL patterns are loaded once and not reset.
        let _ = &self.pattern;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{AgentEvent, AgentEventType};

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

    fn tool_error(ts: u64, name: &str) -> AgentEvent {
        AgentEvent::at(
            ts,
            AgentEventType::ToolResult {
                name: name.into(),
                success: false,
                error: Some("err".into()),
            },
        )
    }

    fn step_end_no_output(ts: u64, step: u32) -> AgentEvent {
        AgentEvent::at(
            ts,
            AgentEventType::StepEnd {
                step_number: step,
                produced_output: false,
            },
        )
    }

    fn llm_call(ts: u64, cost: f64, tokens: u32) -> AgentEvent {
        AgentEvent::at(
            ts,
            AgentEventType::LlmCall {
                model: "test".into(),
                input_tokens: tokens / 2,
                output_tokens: tokens / 2,
                cost_usd: cost,
            },
        )
    }

    #[test]
    fn sase_retry_storm_basic() {
        let mut det = SaseDetector::retry_storm(&super::super::RetryStormConfig {
            min_repetitions: 3,
            window_seconds: 10,
            kill_threshold: None,
        });

        assert!(det.process(&tool_call(1000, "search", 42)).is_empty());
        assert!(det.process(&tool_call(2000, "search", 42)).is_empty());
        let dets = det.process(&tool_call(3000, "search", 42));
        eprintln!("retry_storm after 3 calls: {} detections", dets.len());
        assert!(
            !dets.is_empty(),
            "Should detect retry storm after 3 identical calls"
        );
        assert_eq!(dets[0].pattern_name, "retry_storm");
    }

    #[test]
    fn sase_error_spiral_with_interleaved_events() {
        // Simulates the e2e test: ToolCall -> ToolResult(fail) interleaved
        let mut det = SaseDetector::error_spiral(&super::super::ErrorSpiralConfig {
            min_error_count: 3,
            window_seconds: 30,
            kill_threshold: None,
        });

        let mut total = 0;
        for i in 0..3 {
            // ToolCall first (should be ignored by error spiral)
            det.process(&tool_call(1000 + i * 2000, "tool", 42));
            // Then ToolResult with failure
            let dets = det.process(&tool_error(1500 + i * 2000, "tool"));
            eprintln!(
                "error_spiral interleaved round {}: {} detections",
                i,
                dets.len()
            );
            total += dets.len();
        }
        assert!(
            total > 0,
            "Should detect error spiral with interleaved ToolCall events, got {}",
            total
        );
    }

    #[test]
    fn sase_stuck_agent_with_step_start() {
        // Simulates the e2e test: StepStart -> StepEnd interleaved
        let mut det = SaseDetector::stuck_agent(&super::super::StuckAgentConfig {
            max_steps_without_output: 3,
            max_time_without_output_seconds: 9999,
            kill_threshold: None,
        });

        let mut total = 0;
        for i in 1..=5 {
            // StepStart first (should be ignored by stuck agent)
            det.process(&AgentEvent::at(
                i as u64 * 1000,
                AgentEventType::StepStart { step_number: i },
            ));
            // Then StepEnd with no output
            let dets = det.process(&step_end_no_output(i as u64 * 1000 + 500, i));
            eprintln!(
                "stuck_agent with StepStart, step {}: {} detections",
                i,
                dets.len()
            );
            total += dets.len();
        }
        assert!(
            total > 0,
            "Should detect stuck agent with interleaved StepStart, got {}",
            total
        );
    }

    #[test]
    fn sase_error_spiral_with_success_interleaved() {
        let mut det = SaseDetector::error_spiral(&super::super::ErrorSpiralConfig {
            min_error_count: 3,
            window_seconds: 30,
            kill_threshold: None,
        });

        let mut total = 0;
        // error, error, success, error — should still detect 3 errors
        total += det.process(&tool_error(1000, "a")).len();
        total += det.process(&tool_error(2000, "b")).len();
        // success ToolResult
        total += det
            .process(&AgentEvent::at(
                3000,
                AgentEventType::ToolResult {
                    name: "c".into(),
                    success: true,
                    error: None,
                },
            ))
            .len();
        total += det.process(&tool_error(4000, "d")).len();
        eprintln!(
            "error_spiral with success interleaved: {} detections",
            total
        );
        assert!(
            total > 0,
            "Should detect 3 errors despite interleaved success, got {}",
            total
        );
    }

    #[test]
    fn sase_error_spiral_basic() {
        let mut det = SaseDetector::error_spiral(&super::super::ErrorSpiralConfig {
            min_error_count: 3,
            window_seconds: 30,
            kill_threshold: None,
        });

        let d1 = det.process(&tool_error(1000, "a"));
        eprintln!("error_spiral after 1 error: {} detections", d1.len());
        let d2 = det.process(&tool_error(2000, "b"));
        eprintln!("error_spiral after 2 errors: {} detections", d2.len());
        let d3 = det.process(&tool_error(3000, "c"));
        eprintln!("error_spiral after 3 errors: {} detections", d3.len());

        let total = d1.len() + d2.len() + d3.len();
        assert!(
            total > 0,
            "Should detect error spiral after 3 errors, got {}",
            total
        );
    }

    #[test]
    fn sase_stuck_agent_basic() {
        let mut det = SaseDetector::stuck_agent(&super::super::StuckAgentConfig {
            max_steps_without_output: 3,
            max_time_without_output_seconds: 9999,
            kill_threshold: None,
        });

        let mut total = 0;
        for i in 1..=5 {
            let dets = det.process(&step_end_no_output(1000 * i as u64, i));
            eprintln!("stuck_agent step {}: {} detections", i, dets.len());
            total += dets.len();
        }
        assert!(
            total > 0,
            "Should detect stuck agent after 3+ empty steps, got {}",
            total
        );
    }

    #[test]
    fn vpl_intent_stall_with_metadata() {
        use crate::runtime::AgentRuntime;

        let mut rt = AgentRuntime::new();
        rt.set_cooldown_ms(0);
        let source = include_str!("../../../../patterns/claude-code/intent_stall.vpl");
        rt.add_patterns_from_vpl(source).expect("VPL compile");

        // LlmResponse with intent_without_action=true (via metadata)
        let mut e1 = AgentEvent::at(
            1000,
            crate::event::AgentEventType::LlmResponse {
                model: "test".into(),
                has_tool_use: false,
            },
        );
        e1.metadata
            .insert("intent_without_action".into(), serde_json::json!(true));

        let mut e2 = e1.clone();
        e2.timestamp = 2000;

        assert!(rt.observe(e1).is_empty());
        let dets = rt.observe(e2);
        assert!(
            !dets.is_empty(),
            "Should detect IntentStall from metadata-enriched LlmResponse events"
        );
        assert_eq!(dets[0].pattern_name, "IntentStall");
    }

    #[test]
    fn vpl_compaction_spiral_with_custom_events() {
        use crate::runtime::AgentRuntime;

        let mut rt = AgentRuntime::new();
        rt.set_cooldown_ms(0);
        let source = include_str!("../../../../patterns/claude-code/compaction_spiral.vpl");
        rt.add_patterns_from_vpl(source).expect("VPL compile");

        // Two Compaction events with low freed_ratio
        let mut c1 = AgentEvent::at(
            1000,
            crate::event::AgentEventType::Custom {
                name: "Compaction".into(),
            },
        );
        c1.metadata
            .insert("freed_ratio".into(), serde_json::json!(0.10));

        let mut c2 = c1.clone();
        c2.timestamp = 60_000;

        assert!(rt.observe(c1).is_empty());
        let dets = rt.observe(c2);
        assert!(
            !dets.is_empty(),
            "Should detect CompactionSpiral from Custom Compaction events"
        );
        assert_eq!(dets[0].pattern_name, "CompactionSpiral");
    }

    fn tool_error_with_target(ts: u64, name: &str, target: &str) -> AgentEvent {
        let mut event = AgentEvent::at(
            ts,
            AgentEventType::ToolResult {
                name: name.into(),
                success: false,
                error: Some(format!("FAIL {}", target)),
            },
        );
        event
            .metadata
            .insert("failure_target".into(), serde_json::json!(target));
        event
    }

    #[test]
    fn sase_targeted_failure_basic() {
        let mut det = SaseDetector::targeted_failure(&super::super::TargetedFailureConfig {
            min_failures: 2,
            window_seconds: 60,
        });

        let d1 = det.process(&tool_error_with_target(1000, "bash", "tests/test_auth.py::test_login"));
        assert!(d1.is_empty(), "Should not detect on first failure");

        let d2 = det.process(&tool_error_with_target(2000, "bash", "tests/test_auth.py::test_login"));
        assert!(
            !d2.is_empty(),
            "Should detect targeted failure after 2 failures on same target"
        );
        assert_eq!(d2[0].pattern_name, "targeted_failure");
        assert_eq!(
            d2[0].details.get("failure_target").and_then(|v| v.as_str()),
            Some("tests/test_auth.py::test_login")
        );
    }

    #[test]
    fn sase_targeted_failure_different_targets_no_trigger() {
        let mut det = SaseDetector::targeted_failure(&super::super::TargetedFailureConfig {
            min_failures: 2,
            window_seconds: 60,
        });

        det.process(&tool_error_with_target(1000, "bash", "test_a"));
        let d2 = det.process(&tool_error_with_target(2000, "bash", "test_b"));
        // The SASE engine will still match 2 ToolResult{success=false} events,
        // but the post-match handler groups by target — neither target has 2 failures.
        // However, the Kleene+ match gives us all events in stack, so we need to check
        // that no target individually reaches the threshold.
        let targeted = d2
            .iter()
            .any(|d| d.details.get("failure_count").and_then(|v| v.as_u64()) >= Some(2));
        assert!(
            !targeted,
            "Different targets should not individually reach threshold"
        );
    }

    #[test]
    fn sase_budget_basic() {
        let mut det = SaseDetector::budget_runaway(&super::super::BudgetRunawayConfig {
            max_cost_usd: 0.10,
            max_tokens: 999999,
            window_seconds: 60,
        });

        let mut total = 0;
        for i in 0..8 {
            let dets = det.process(&llm_call(1000 + i * 1000, 0.015, 200));
            eprintln!(
                "budget step {}: {} detections (cost so far ~${:.3})",
                i,
                dets.len(),
                (i + 1) as f64 * 0.015
            );
            total += dets.len();
        }
        assert!(total > 0, "Should detect budget runaway, got {}", total);
    }
}
