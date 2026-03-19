/** A normalized event from an AI agent's execution. */
export interface AgentEvent {
  /** Milliseconds since Unix epoch. */
  timestamp: number;
  /** The type and payload of this event. */
  event_type: AgentEventType;
  /** Arbitrary key-value metadata. */
  metadata?: Record<string, unknown>;
}

/** Discriminated union of all agent event types. */
export type AgentEventType =
  | { type: "ToolCall"; name: string; params_hash: number; duration_ms?: number }
  | { type: "ToolResult"; name: string; success: boolean; error?: string }
  | {
      type: "LlmCall";
      model: string;
      input_tokens: number;
      output_tokens: number;
      cost_usd?: number;
    }
  | { type: "LlmResponse"; model: string; has_tool_use: boolean }
  | { type: "StepStart"; step_number: number }
  | { type: "StepEnd"; step_number: number; produced_output: boolean }
  | { type: "FinalAnswer"; content_length: number };

/** A detection emitted when a behavioral pattern matches. */
export interface Detection {
  pattern_name: string;
  severity: "info" | "warning" | "error" | "critical";
  message: string;
  details: Record<string, unknown>;
  timestamp: number;
}

/** Configuration for the retry storm pattern detector. */
export interface RetryStormConfig {
  /** Minimum identical calls to trigger. Default: 3. */
  min_repetitions?: number;
  /** Sliding window in seconds. Default: 10. */
  window_seconds?: number;
}

/** Configuration for the stuck agent pattern detector. */
export interface StuckAgentConfig {
  /** Max steps without output before alerting. Default: 15. */
  max_steps_without_output?: number;
  /** Max seconds without output before alerting. Default: 120. */
  max_time_without_output_seconds?: number;
}

/** A pattern configuration passed to the runtime constructor. */
export interface PatternConfig {
  type: "retry_storm" | "stuck_agent";
  config: RetryStormConfig | StuckAgentConfig;
}

/** Runtime configuration. */
export interface RuntimeConfig {
  /** Pattern detectors to enable. */
  patterns?: PatternConfig[];
  /** Cooldown in ms between repeated detections of the same pattern. Default: 30000. */
  cooldown_ms?: number;
}
