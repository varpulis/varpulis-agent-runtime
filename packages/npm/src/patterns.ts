import type { PatternConfig, RetryStormConfig, StuckAgentConfig } from "./types.js";

/** Builder helpers for pre-packaged pattern configurations. */
export class Patterns {
  /** Detect repeated identical tool calls within a time window. */
  static retryStorm(config: RetryStormConfig = {}): PatternConfig {
    return { type: "retry_storm", config };
  }

  /** Detect an agent that hasn't produced output after too many steps or too long. */
  static stuckAgent(config: StuckAgentConfig = {}): PatternConfig {
    return { type: "stuck_agent", config };
  }

  /** All default patterns with default configurations. */
  static defaults(): PatternConfig[] {
    return [Patterns.retryStorm(), Patterns.stuckAgent()];
  }
}
