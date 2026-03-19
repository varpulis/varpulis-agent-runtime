use wasm_bindgen::prelude::*;

use varpulis_agent_core::event::AgentEvent;
use varpulis_agent_core::pattern::{
    RetryStormConfig, RetryStormDetector, StuckAgentConfig, StuckAgentDetector,
};
use varpulis_agent_core::runtime::AgentRuntime;

/// WASM-accessible wrapper around the Rust AgentRuntime.
///
/// Events and detections are passed as JSON strings across the WASM boundary.
#[wasm_bindgen]
pub struct WasmAgentRuntime {
    inner: AgentRuntime,
}

#[wasm_bindgen]
impl WasmAgentRuntime {
    /// Create an empty runtime with no detectors.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: AgentRuntime::new(),
        }
    }

    /// Create a runtime with default patterns (retry_storm + stuck_agent).
    #[wasm_bindgen(js_name = "withDefaultPatterns")]
    pub fn with_default_patterns() -> Self {
        Self {
            inner: AgentRuntime::with_default_patterns(),
        }
    }

    /// Add a retry storm detector with the given configuration.
    /// `config_json`: `{ "min_repetitions": 3, "window_seconds": 10 }`
    #[wasm_bindgen(js_name = "addRetryStorm")]
    pub fn add_retry_storm(&mut self, config_json: &str) -> Result<(), JsError> {
        let config: RetryStormConfigJs =
            serde_json::from_str(config_json).map_err(|e| JsError::new(&e.to_string()))?;
        self.inner.add_detector(Box::new(RetryStormDetector::new(
            RetryStormConfig {
                min_repetitions: config.min_repetitions.unwrap_or(3),
                window_seconds: config.window_seconds.unwrap_or(10),
            },
        )));
        Ok(())
    }

    /// Add a stuck agent detector with the given configuration.
    /// `config_json`: `{ "max_steps_without_output": 15, "max_time_without_output_seconds": 120 }`
    #[wasm_bindgen(js_name = "addStuckAgent")]
    pub fn add_stuck_agent(&mut self, config_json: &str) -> Result<(), JsError> {
        let config: StuckAgentConfigJs =
            serde_json::from_str(config_json).map_err(|e| JsError::new(&e.to_string()))?;
        self.inner
            .add_detector(Box::new(StuckAgentDetector::new(StuckAgentConfig {
                max_steps_without_output: config.max_steps_without_output.unwrap_or(15),
                max_time_without_output_seconds: config
                    .max_time_without_output_seconds
                    .unwrap_or(120),
            })));
        Ok(())
    }

    /// Set the cooldown period in milliseconds between repeated detections
    /// of the same pattern.
    #[wasm_bindgen(js_name = "setCooldownMs")]
    pub fn set_cooldown_ms(&mut self, ms: u64) {
        self.inner.set_cooldown_ms(ms);
    }

    /// Push an event (as JSON) and return detections (as JSON array).
    ///
    /// Event JSON must match the `AgentEvent` schema with a tagged `event_type`.
    /// Returns `"[]"` if no detections fired.
    pub fn observe(&mut self, event_json: &str) -> Result<String, JsError> {
        let event: AgentEvent =
            serde_json::from_str(event_json).map_err(|e| JsError::new(&e.to_string()))?;
        let detections = self.inner.observe(event);
        serde_json::to_string(&detections).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Reset all detector state and cooldowns.
    pub fn reset(&mut self) {
        self.inner.reset();
    }

    /// Number of events processed.
    #[wasm_bindgen(js_name = "eventCount")]
    pub fn event_count(&self) -> u64 {
        self.inner.event_count()
    }
}

/// JSON-friendly config structs with optional fields (defaults applied in Rust).
#[derive(serde::Deserialize)]
struct RetryStormConfigJs {
    min_repetitions: Option<u32>,
    window_seconds: Option<u64>,
}

#[derive(serde::Deserialize)]
struct StuckAgentConfigJs {
    max_steps_without_output: Option<u32>,
    max_time_without_output_seconds: Option<u64>,
}
