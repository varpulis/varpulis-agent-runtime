use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// A normalized event from an AI agent's execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentEvent {
    /// Milliseconds since Unix epoch.
    pub timestamp: u64,
    /// The type and payload of this event.
    pub event_type: AgentEventType,
    /// Arbitrary key-value metadata.
    #[serde(default)]
    pub metadata: HashMap<String, serde_json::Value>,
}

/// The discriminated union of all agent event types.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AgentEventType {
    ToolCall {
        name: String,
        params_hash: u64,
        #[serde(default)]
        duration_ms: u64,
    },
    ToolResult {
        name: String,
        success: bool,
        #[serde(default)]
        error: Option<String>,
    },
    LlmCall {
        model: String,
        input_tokens: u32,
        output_tokens: u32,
        #[serde(default)]
        cost_usd: f64,
    },
    LlmResponse {
        model: String,
        has_tool_use: bool,
    },
    StepStart {
        step_number: u32,
    },
    StepEnd {
        step_number: u32,
        produced_output: bool,
    },
    FinalAnswer {
        content_length: u32,
    },
}

impl AgentEvent {
    /// Create an event with the given type and current timestamp.
    pub fn now(event_type: AgentEventType) -> Self {
        Self {
            timestamp: current_time_ms(),
            event_type,
            metadata: HashMap::new(),
        }
    }

    /// Create an event with an explicit timestamp.
    pub fn at(timestamp: u64, event_type: AgentEventType) -> Self {
        Self {
            timestamp,
            event_type,
            metadata: HashMap::new(),
        }
    }

    /// Convert to a Varpulis CEP Event for pattern matching.
    pub fn to_cep_event(&self) -> varpulis_core::Event {
        let (event_type, fields) = match &self.event_type {
            AgentEventType::ToolCall {
                name,
                params_hash,
                duration_ms,
            } => (
                "ToolCall",
                vec![
                    ("name", varpulis_core::Value::from(name.as_str())),
                    (
                        "params_hash",
                        varpulis_core::Value::Int(*params_hash as i64),
                    ),
                    (
                        "duration_ms",
                        varpulis_core::Value::Int(*duration_ms as i64),
                    ),
                ],
            ),
            AgentEventType::ToolResult {
                name,
                success,
                error,
            } => (
                "ToolResult",
                vec![
                    ("name", varpulis_core::Value::from(name.as_str())),
                    ("success", varpulis_core::Value::Bool(*success)),
                    (
                        "error",
                        varpulis_core::Value::from(error.as_deref().unwrap_or("")),
                    ),
                ],
            ),
            AgentEventType::LlmCall {
                model,
                input_tokens,
                output_tokens,
                cost_usd,
            } => (
                "LlmCall",
                vec![
                    ("model", varpulis_core::Value::from(model.as_str())),
                    (
                        "input_tokens",
                        varpulis_core::Value::Int(*input_tokens as i64),
                    ),
                    (
                        "output_tokens",
                        varpulis_core::Value::Int(*output_tokens as i64),
                    ),
                    ("cost_usd", varpulis_core::Value::Float(*cost_usd)),
                ],
            ),
            AgentEventType::LlmResponse {
                model,
                has_tool_use,
            } => (
                "LlmResponse",
                vec![
                    ("model", varpulis_core::Value::from(model.as_str())),
                    ("has_tool_use", varpulis_core::Value::Bool(*has_tool_use)),
                ],
            ),
            AgentEventType::StepStart { step_number } => (
                "StepStart",
                vec![(
                    "step_number",
                    varpulis_core::Value::Int(*step_number as i64),
                )],
            ),
            AgentEventType::StepEnd {
                step_number,
                produced_output,
            } => (
                "StepEnd",
                vec![
                    (
                        "step_number",
                        varpulis_core::Value::Int(*step_number as i64),
                    ),
                    (
                        "produced_output",
                        varpulis_core::Value::Bool(*produced_output),
                    ),
                ],
            ),
            AgentEventType::FinalAnswer { content_length } => (
                "FinalAnswer",
                vec![(
                    "content_length",
                    varpulis_core::Value::Int(*content_length as i64),
                )],
            ),
        };

        let ts = chrono::DateTime::from_timestamp_millis(self.timestamp as i64).unwrap_or_default();

        let mut cep_event = varpulis_core::Event::new(event_type).with_timestamp(ts);
        for (key, value) in fields {
            cep_event = cep_event.with_field(key, value);
        }
        cep_event
    }

    /// Returns the tool name if this is a ToolCall or ToolResult event.
    pub fn tool_name(&self) -> Option<&str> {
        match &self.event_type {
            AgentEventType::ToolCall { name, .. } | AgentEventType::ToolResult { name, .. } => {
                Some(name)
            }
            _ => None,
        }
    }
}

fn current_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before epoch")
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tool_name_extraction() {
        let event = AgentEvent::at(
            0,
            AgentEventType::ToolCall {
                name: "search".into(),
                params_hash: 42,
                duration_ms: 100,
            },
        );
        assert_eq!(event.tool_name(), Some("search"));

        let event = AgentEvent::at(
            0,
            AgentEventType::FinalAnswer {
                content_length: 100,
            },
        );
        assert_eq!(event.tool_name(), None);
    }

    #[test]
    fn test_serde_roundtrip() {
        let event = AgentEvent::at(
            1000,
            AgentEventType::ToolCall {
                name: "search".into(),
                params_hash: 42,
                duration_ms: 100,
            },
        );
        let json = serde_json::to_string(&event).unwrap();
        let parsed: AgentEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.timestamp, 1000);
        assert_eq!(parsed.tool_name(), Some("search"));
    }
}
