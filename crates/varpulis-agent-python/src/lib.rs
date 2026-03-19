use pyo3::prelude::*;

use varpulis_agent_core::event::AgentEvent;
use varpulis_agent_core::pattern::{
    BudgetRunawayConfig, BudgetRunawayDetector, CircularReasoningConfig, CircularReasoningDetector,
    ErrorSpiralConfig, ErrorSpiralDetector, RetryStormConfig, RetryStormDetector, StuckAgentConfig,
    StuckAgentDetector, TokenVelocityConfig, TokenVelocitySpikeDetector,
};
use varpulis_agent_core::runtime::AgentRuntime;

/// Python-accessible wrapper around the Rust AgentRuntime.
///
/// Events and detections are passed as JSON strings across the FFI boundary.
#[pyclass]
struct PyAgentRuntime {
    inner: AgentRuntime,
}

#[pymethods]
impl PyAgentRuntime {
    /// Create an empty runtime with no detectors.
    #[new]
    fn new() -> Self {
        Self {
            inner: AgentRuntime::new(),
        }
    }

    /// Create a runtime with all default patterns.
    #[staticmethod]
    fn with_default_patterns() -> Self {
        Self {
            inner: AgentRuntime::with_default_patterns(),
        }
    }

    /// Add a retry storm detector.
    fn add_retry_storm(&mut self, config_json: &str) -> PyResult<()> {
        let config: RetryStormConfigJs = serde_json::from_str(config_json)
            .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(e.to_string()))?;
        self.inner
            .add_detector(Box::new(RetryStormDetector::new(RetryStormConfig {
                min_repetitions: config.min_repetitions.unwrap_or(3),
                window_seconds: config.window_seconds.unwrap_or(10),
            })));
        Ok(())
    }

    /// Add a stuck agent detector.
    fn add_stuck_agent(&mut self, config_json: &str) -> PyResult<()> {
        let config: StuckAgentConfigJs = serde_json::from_str(config_json)
            .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(e.to_string()))?;
        self.inner
            .add_detector(Box::new(StuckAgentDetector::new(StuckAgentConfig {
                max_steps_without_output: config.max_steps_without_output.unwrap_or(15),
                max_time_without_output_seconds: config
                    .max_time_without_output_seconds
                    .unwrap_or(120),
            })));
        Ok(())
    }

    /// Add an error spiral detector.
    fn add_error_spiral(&mut self, config_json: &str) -> PyResult<()> {
        let config: ErrorSpiralConfigJs = serde_json::from_str(config_json)
            .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(e.to_string()))?;
        self.inner
            .add_detector(Box::new(ErrorSpiralDetector::new(ErrorSpiralConfig {
                min_error_count: config.min_error_count.unwrap_or(3),
                window_seconds: config.window_seconds.unwrap_or(30),
            })));
        Ok(())
    }

    /// Add a budget runaway detector.
    fn add_budget_runaway(&mut self, config_json: &str) -> PyResult<()> {
        let config: BudgetRunawayConfigJs = serde_json::from_str(config_json)
            .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(e.to_string()))?;
        self.inner
            .add_detector(Box::new(BudgetRunawayDetector::new(BudgetRunawayConfig {
                max_cost_usd: config.max_cost_usd.unwrap_or(1.00),
                max_tokens: config.max_tokens.unwrap_or(100_000),
                window_seconds: config.window_seconds.unwrap_or(60),
            })));
        Ok(())
    }

    /// Add a token velocity spike detector.
    fn add_token_velocity(&mut self, config_json: &str) -> PyResult<()> {
        let config: TokenVelocityConfigJs = serde_json::from_str(config_json)
            .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(e.to_string()))?;
        self.inner
            .add_detector(Box::new(TokenVelocitySpikeDetector::new(
                TokenVelocityConfig {
                    baseline_window_steps: config.baseline_window_steps.unwrap_or(5),
                    spike_multiplier: config.spike_multiplier.unwrap_or(2.0),
                },
            )));
        Ok(())
    }

    /// Add a circular reasoning detector.
    fn add_circular_reasoning(&mut self, config_json: &str) -> PyResult<()> {
        let config: CircularReasoningConfigJs = serde_json::from_str(config_json)
            .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(e.to_string()))?;
        self.inner
            .add_detector(Box::new(CircularReasoningDetector::new(
                CircularReasoningConfig {
                    max_cycle_length: config.max_cycle_length.unwrap_or(4),
                    min_cycle_repetitions: config.min_cycle_repetitions.unwrap_or(2),
                },
            )));
        Ok(())
    }

    /// Set the cooldown period in milliseconds.
    fn set_cooldown_ms(&mut self, ms: u64) {
        self.inner.set_cooldown_ms(ms);
    }

    /// Push an event (as JSON) and return detections (as JSON array).
    fn observe(&mut self, event_json: &str) -> PyResult<String> {
        let event: AgentEvent = serde_json::from_str(event_json)
            .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(e.to_string()))?;
        let detections = self.inner.observe(event);
        serde_json::to_string(&detections)
            .map_err(|e| PyErr::new::<pyo3::exceptions::PyRuntimeError, _>(e.to_string()))
    }

    /// Reset all detector state and cooldowns.
    fn reset(&mut self) {
        self.inner.reset();
    }

    /// Number of events processed.
    fn event_count(&self) -> u64 {
        self.inner.event_count()
    }
}

// JSON-friendly config structs.
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

#[derive(serde::Deserialize)]
struct ErrorSpiralConfigJs {
    min_error_count: Option<u32>,
    window_seconds: Option<u64>,
}

#[derive(serde::Deserialize)]
struct BudgetRunawayConfigJs {
    max_cost_usd: Option<f64>,
    max_tokens: Option<u32>,
    window_seconds: Option<u64>,
}

#[derive(serde::Deserialize)]
struct TokenVelocityConfigJs {
    baseline_window_steps: Option<u32>,
    spike_multiplier: Option<f64>,
}

#[derive(serde::Deserialize)]
struct CircularReasoningConfigJs {
    max_cycle_length: Option<u32>,
    min_cycle_repetitions: Option<u32>,
}

/// The Python module.
#[pymodule]
fn _core(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<PyAgentRuntime>()?;
    Ok(())
}
