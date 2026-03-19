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

  it("returns all defaults", () => {
    const all = Patterns.defaults();
    expect(all).toHaveLength(2);
    expect(all.map((p) => p.type)).toEqual(["retry_storm", "stuck_agent"]);
  });
});
