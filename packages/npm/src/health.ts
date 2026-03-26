import type { Detection } from "./types.js";

const DEFAULT_WEIGHTS: Record<string, number> = {
  retry_storm: 0.08,
  stuck_agent: 0.08,
  error_spiral: 0.08,
  budget_runaway: 0.10,
  token_velocity: 0.04,
  circular_reasoning: 0.08,
  IntentStall: 0.12,
  CompactionSpiral: 0.18,
  MemoryLossViolation: 0.18,
  ContextStarvation: 0.03,
  IdleCompaction: 0.03,
  targeted_failure: 0.06,
  stale_guardrail: 0.15,
};

const SEVERITY_MULTIPLIERS: Record<string, number> = {
  info: 0.25,
  warning: 0.5,
  error: 0.75,
  critical: 1.0,
};

export interface HealthScoreConfig {
  weights?: Partial<Record<string, number>>;
}

/**
 * Computes an aggregate health score from active detections.
 * 1.0 = fully healthy, 0.0 = critical.
 */
export class HealthScoreTracker {
  private weights: Record<string, number>;

  constructor(config?: HealthScoreConfig) {
    this.weights = {
      ...DEFAULT_WEIGHTS,
      ...(config?.weights as Record<string, number> | undefined),
    };
  }

  /**
   * Compute health score from a list of active detections.
   * Each detection reduces the score by its weight * severity multiplier.
   * The result is clamped to [0, 1].
   */
  compute(activeDetections: Detection[]): number {
    let penalty = 0;

    for (const d of activeDetections) {
      const weight = this.weights[d.pattern_name] ?? 0.05;
      const multiplier = SEVERITY_MULTIPLIERS[d.severity] ?? 0.5;
      penalty += weight * multiplier;
    }

    return Math.max(0, Math.min(1, 1 - penalty));
  }

  /**
   * Map a numeric score to a status string.
   */
  status(score: number): "healthy" | "degraded" | "unhealthy" | "critical" {
    if (score >= 0.8) return "healthy";
    if (score >= 0.5) return "degraded";
    if (score >= 0.2) return "unhealthy";
    return "critical";
  }
}
