use crate::action::{ActionDispatcher, DetectionCallback};
use crate::cooldown::CooldownManager;
use crate::event::AgentEvent;
use crate::pattern::detector::{Detection, PatternDetector};
use crate::pattern::retry_storm::{RetryStormConfig, RetryStormDetector};
use crate::pattern::stuck_agent::{StuckAgentConfig, StuckAgentDetector};

/// The main runtime that orchestrates pattern detection for an AI agent.
///
/// Feed agent events via [`observe()`](Self::observe) and receive detections
/// when behavioral patterns are matched.
pub struct AgentRuntime {
    detectors: Vec<Box<dyn PatternDetector>>,
    dispatcher: ActionDispatcher,
    cooldown: CooldownManager,
    event_count: u64,
}

impl AgentRuntime {
    /// Create an empty runtime with no detectors.
    pub fn new() -> Self {
        Self {
            detectors: Vec::new(),
            dispatcher: ActionDispatcher::new(),
            cooldown: CooldownManager::default(),
            event_count: 0,
        }
    }

    /// Create a runtime pre-loaded with default pattern detectors
    /// (retry_storm + stuck_agent with default configs).
    pub fn with_default_patterns() -> Self {
        let mut runtime = Self::new();
        runtime.add_detector(Box::new(RetryStormDetector::new(
            RetryStormConfig::default(),
        )));
        runtime.add_detector(Box::new(StuckAgentDetector::new(
            StuckAgentConfig::default(),
        )));
        runtime
    }

    /// Add a pattern detector.
    pub fn add_detector(&mut self, detector: Box<dyn PatternDetector>) {
        self.detectors.push(detector);
    }

    /// Register a callback invoked on every detection (after cooldown filtering).
    pub fn on_detection(&mut self, cb: DetectionCallback) {
        self.dispatcher.on_detection(cb);
    }

    /// Set the cooldown period in milliseconds.
    pub fn set_cooldown_ms(&mut self, ms: u64) {
        self.cooldown = CooldownManager::new(ms);
    }

    /// Push an event through all detectors. Returns all detections that fired
    /// (after cooldown filtering).
    pub fn observe(&mut self, event: AgentEvent) -> Vec<Detection> {
        self.event_count += 1;

        let mut all_detections = Vec::new();

        for detector in &mut self.detectors {
            let detections = detector.process(&event);
            for detection in detections {
                if self
                    .cooldown
                    .try_fire(&detection.pattern_name, detection.timestamp)
                {
                    self.dispatcher.dispatch(&detection);
                    all_detections.push(detection);
                }
            }
        }

        all_detections
    }

    /// Reset all detector state and cooldowns.
    pub fn reset(&mut self) {
        for detector in &mut self.detectors {
            detector.reset();
        }
        self.cooldown.reset();
        self.event_count = 0;
    }

    /// Number of events processed so far.
    pub fn event_count(&self) -> u64 {
        self.event_count
    }
}

impl Default for AgentRuntime {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    use super::*;
    use crate::event::AgentEventType;

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

    fn step_end(ts: u64, step: u32) -> AgentEvent {
        AgentEvent::at(
            ts,
            AgentEventType::StepEnd {
                step_number: step,
                produced_output: false,
            },
        )
    }

    #[test]
    fn observe_returns_detections() {
        let mut rt = AgentRuntime::new();
        rt.add_detector(Box::new(RetryStormDetector::new(RetryStormConfig {
            min_repetitions: 2,
            window_seconds: 10,
        })));

        assert!(rt.observe(tool_call(1000, "search", 42)).is_empty());
        let dets = rt.observe(tool_call(2000, "search", 42));
        assert_eq!(dets.len(), 1);
        assert_eq!(dets[0].pattern_name, "retry_storm");
    }

    #[test]
    fn callbacks_are_invoked() {
        let count = Arc::new(AtomicU32::new(0));
        let count_clone = count.clone();

        let mut rt = AgentRuntime::new();
        rt.add_detector(Box::new(RetryStormDetector::new(RetryStormConfig {
            min_repetitions: 2,
            window_seconds: 10,
        })));
        rt.on_detection(Box::new(move |_det| {
            count_clone.fetch_add(1, Ordering::Relaxed);
        }));

        rt.observe(tool_call(1000, "search", 42));
        rt.observe(tool_call(2000, "search", 42));

        assert_eq!(count.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn cooldown_prevents_repeated_alerts() {
        let mut rt = AgentRuntime::new();
        rt.set_cooldown_ms(5000);
        rt.add_detector(Box::new(RetryStormDetector::new(RetryStormConfig {
            min_repetitions: 2,
            window_seconds: 10,
        })));

        rt.observe(tool_call(1000, "search", 42));
        assert_eq!(rt.observe(tool_call(2000, "search", 42)).len(), 1);
        // Still within cooldown — should be suppressed.
        assert_eq!(rt.observe(tool_call(3000, "search", 42)).len(), 0);
        // After cooldown.
        assert_eq!(rt.observe(tool_call(8000, "search", 42)).len(), 1);
    }

    #[test]
    fn multiple_detectors_run() {
        let mut rt = AgentRuntime::new();
        rt.set_cooldown_ms(0);
        rt.add_detector(Box::new(RetryStormDetector::new(RetryStormConfig {
            min_repetitions: 2,
            window_seconds: 10,
        })));
        rt.add_detector(Box::new(StuckAgentDetector::new(StuckAgentConfig {
            max_steps_without_output: 2,
            max_time_without_output_seconds: 9999,
        })));

        // Fire retry storm.
        rt.observe(tool_call(1000, "search", 42));
        let dets = rt.observe(tool_call(2000, "search", 42));
        assert_eq!(dets.len(), 1);
        assert_eq!(dets[0].pattern_name, "retry_storm");

        // Fire stuck agent.
        rt.observe(step_end(3000, 1));
        let dets = rt.observe(step_end(4000, 2));
        assert_eq!(dets.len(), 1);
        assert_eq!(dets[0].pattern_name, "stuck_agent");
    }

    #[test]
    fn event_count_tracks() {
        let mut rt = AgentRuntime::with_default_patterns();
        assert_eq!(rt.event_count(), 0);

        rt.observe(tool_call(1000, "search", 42));
        rt.observe(tool_call(2000, "search", 42));
        assert_eq!(rt.event_count(), 2);

        rt.reset();
        assert_eq!(rt.event_count(), 0);
    }
}
