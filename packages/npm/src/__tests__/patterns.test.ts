import { describe, it, expect } from "vitest";
import { Patterns } from "../patterns.js";

describe("Patterns", () => {
  it("creates retry_storm config with defaults", () => {
    const p = Patterns.retryStorm();
    expect(p.type).toBe("retry_storm");
    expect(p.config).toEqual({});
  });

  it("creates retry_storm config with custom values", () => {
    const p = Patterns.retryStorm({ min_repetitions: 5, window_seconds: 30 });
    expect(p.type).toBe("retry_storm");
    expect(p.config).toEqual({ min_repetitions: 5, window_seconds: 30 });
  });

  it("creates stuck_agent config", () => {
    const p = Patterns.stuckAgent({ max_steps_without_output: 10 });
    expect(p.type).toBe("stuck_agent");
    expect(p.config).toEqual({ max_steps_without_output: 10 });
  });

  it("creates error_spiral config", () => {
    const p = Patterns.errorSpiral({ min_error_count: 5 });
    expect(p.type).toBe("error_spiral");
    expect(p.config).toEqual({ min_error_count: 5 });
  });

  it("creates budget_runaway config", () => {
    const p = Patterns.budgetRunaway({ max_cost_usd: 0.50, max_tokens: 50000 });
    expect(p.type).toBe("budget_runaway");
    expect(p.config).toEqual({ max_cost_usd: 0.50, max_tokens: 50000 });
  });

  it("creates token_velocity config", () => {
    const p = Patterns.tokenVelocity({ spike_multiplier: 3.0 });
    expect(p.type).toBe("token_velocity");
    expect(p.config).toEqual({ spike_multiplier: 3.0 });
  });

  it("creates circular_reasoning config", () => {
    const p = Patterns.circularReasoning({ max_cycle_length: 6 });
    expect(p.type).toBe("circular_reasoning");
    expect(p.config).toEqual({ max_cycle_length: 6 });
  });

  it("returns all 6 defaults", () => {
    const all = Patterns.defaults();
    expect(all).toHaveLength(6);
    expect(all.map((p) => p.type)).toEqual([
      "retry_storm",
      "stuck_agent",
      "error_spiral",
      "budget_runaway",
      "token_velocity",
      "circular_reasoning",
    ]);
  });
});
