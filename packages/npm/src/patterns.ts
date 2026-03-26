import type {
  BudgetRunawayConfig,
  CircularReasoningConfig,
  ErrorSpiralConfig,
  PatternConfig,
  RetryStormConfig,
  StuckAgentConfig,
  TargetedFailureConfig,
  TokenVelocityConfig,
} from "./types.js";

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

  /** Detect repeated tool call failures within a time window. */
  static errorSpiral(config: ErrorSpiralConfig = {}): PatternConfig {
    return { type: "error_spiral", config };
  }

  /** Detect cumulative LLM cost or token usage exceeding thresholds. */
  static budgetRunaway(config: BudgetRunawayConfig = {}): PatternConfig {
    return { type: "budget_runaway", config };
  }

  /** Detect sudden spikes in token consumption rate per step. */
  static tokenVelocity(config: TokenVelocityConfig = {}): PatternConfig {
    return { type: "token_velocity", config };
  }

  /** Detect repeating cycles in tool call sequences. */
  static circularReasoning(config: CircularReasoningConfig = {}): PatternConfig {
    return { type: "circular_reasoning", config };
  }

  /** Detect repeated failures on the same target (test, file, endpoint) within a session. */
  static targetedFailure(config: TargetedFailureConfig = {}): PatternConfig {
    return { type: "targeted_failure", config };
  }

  /** All default patterns with default configurations. */
  static defaults(): PatternConfig[] {
    return [
      Patterns.retryStorm(),
      Patterns.stuckAgent(),
      Patterns.errorSpiral(),
      Patterns.budgetRunaway(),
      Patterns.tokenVelocity(),
      Patterns.circularReasoning(),
    ];
  }
}
