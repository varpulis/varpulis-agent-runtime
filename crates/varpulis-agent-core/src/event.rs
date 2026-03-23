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
    /// Custom/synthetic event type for adapter-generated events.
    /// The `name` becomes the CEP event type (e.g. "Compaction", "RuleViolation").
    /// All meaningful fields should be placed in `AgentEvent::metadata`.
    Custom {
        name: String,
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
            AgentEventType::Custom { name } => (name.as_str(), vec![]),
        };

        let ts = chrono::DateTime::from_timestamp_millis(self.timestamp as i64).unwrap_or_default();

        let mut cep_event = varpulis_core::Event::new(event_type).with_timestamp(ts);
        for (key, value) in fields {
            cep_event = cep_event.with_field(key, value);
        }

        // Forward metadata fields to CEP event so VPL patterns can match on them.
        for (key, value) in &self.metadata {
            let cep_value = json_to_cep_value(value);
            if let Some(v) = cep_value {
                cep_event = cep_event.with_field(key.as_str(), v);
            }
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

    /// Returns the CEP event type name string.
    pub fn event_type_name(&self) -> &str {
        match &self.event_type {
            AgentEventType::ToolCall { .. } => "ToolCall",
            AgentEventType::ToolResult { .. } => "ToolResult",
            AgentEventType::LlmCall { .. } => "LlmCall",
            AgentEventType::LlmResponse { .. } => "LlmResponse",
            AgentEventType::StepStart { .. } => "StepStart",
            AgentEventType::StepEnd { .. } => "StepEnd",
            AgentEventType::FinalAnswer { .. } => "FinalAnswer",
            AgentEventType::Custom { name } => name,
        }
    }
}

/// Convert a serde_json::Value to a Varpulis CEP Value for metadata forwarding.
fn json_to_cep_value(value: &serde_json::Value) -> Option<varpulis_core::Value> {
    match value {
        serde_json::Value::Bool(b) => Some(varpulis_core::Value::Bool(*b)),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Some(varpulis_core::Value::Int(i))
            } else {
                n.as_f64().map(varpulis_core::Value::Float)
            }
        }
        serde_json::Value::String(s) => Some(varpulis_core::Value::from(s.as_str())),
        _ => None, // Arrays/objects/null not forwarded
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

    #[test]
    fn test_custom_event_serde() {
        let json = r#"{"timestamp":1000,"event_type":{"type":"Custom","name":"Compaction"},"metadata":{"freed_ratio":0.12}}"#;
        let event: AgentEvent = serde_json::from_str(json).unwrap();
        assert_eq!(event.event_type_name(), "Compaction");
        assert_eq!(
            event.metadata.get("freed_ratio").and_then(|v| v.as_f64()),
            Some(0.12)
        );
    }

    #[test]
    fn test_metadata_forwarded_to_cep() {
        let mut event = AgentEvent::at(
            1000,
            AgentEventType::LlmResponse {
                model: "test".into(),
                has_tool_use: false,
            },
        );
        event.metadata.insert(
            "intent_without_action".into(),
            serde_json::Value::Bool(true),
        );
        event
            .metadata
            .insert("hedge_count".into(), serde_json::json!(3));

        let cep = event.to_cep_event();
        // Typed fields should be present
        assert_eq!(cep.get_str("model"), Some("test"));
        // Metadata fields should be forwarded as CEP fields
        // (intent_without_action is a Bool, forwarded via json_to_cep_value)
        assert!(cep.get("intent_without_action").is_some());
        assert_eq!(cep.get_int("hedge_count"), Some(3));
    }

    #[test]
    fn test_custom_event_metadata_to_cep() {
        let mut event = AgentEvent::at(
            1000,
            AgentEventType::Custom {
                name: "Compaction".into(),
            },
        );
        event
            .metadata
            .insert("freed_ratio".into(), serde_json::json!(0.12));
        event
            .metadata
            .insert("system_context_ratio".into(), serde_json::json!(0.75));

        let cep = event.to_cep_event();
        assert_eq!(&*cep.event_type, "Compaction");
        // All fields come from metadata for Custom events
        assert!(cep.get_float("freed_ratio").is_some());
        assert!(cep.get_float("system_context_ratio").is_some());
    }
}
