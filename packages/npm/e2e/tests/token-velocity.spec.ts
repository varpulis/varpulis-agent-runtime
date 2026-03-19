import { test, expect } from "@playwright/test";

test.describe("Token Velocity Spike Detection", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => window.VarpulisTestHarness?.ready);
  });

  test("detects sudden spike in token consumption per step", async ({ page }) => {
    const result = await page.evaluate(() => {
      const { createRuntime, Patterns } = window.VarpulisTestHarness;

      const runtime = createRuntime({
        patterns: [Patterns.tokenVelocity({ baseline_window_steps: 3, spike_multiplier: 2.0 })],
        cooldown_ms: 0,
      });

      const detections: any[] = [];
      let t = 1000000;

      // Build baseline: 3 steps at ~500 tokens each
      for (let i = 0; i < 3; i++) {
        t += 1000;
        runtime.observe({ timestamp: t, event_type: { type: "StepStart", step_number: i } });
        t += 100;
        runtime.observe({
          timestamp: t,
          event_type: { type: "LlmCall", model: "test", input_tokens: 250, output_tokens: 250, cost_usd: 0.01 },
        });
        t += 200;
        const d = runtime.observe({
          timestamp: t,
          event_type: { type: "StepEnd", step_number: i, produced_output: false },
        });
        detections.push(...d);
      }

      // Spike: step with 2000 tokens (4x baseline avg of ~500)
      t += 1000;
      runtime.observe({ timestamp: t, event_type: { type: "StepStart", step_number: 3 } });
      t += 100;
      runtime.observe({
        timestamp: t,
        event_type: { type: "LlmCall", model: "test", input_tokens: 1000, output_tokens: 1000, cost_usd: 0.05 },
      });
      t += 200;
      const d = runtime.observe({
        timestamp: t,
        event_type: { type: "StepEnd", step_number: 3, produced_output: false },
      });
      detections.push(...d);

      return {
        totalDetections: detections.length,
        detection: detections[0],
      };
    });

    expect(result.totalDetections).toBe(1);
    expect(result.detection.pattern_name).toBe("token_velocity_spike");
    expect(result.detection.severity).toBe("warning");
    expect(result.detection.details.current_tokens).toBe(2000);
  });

  test("no detection during baseline buildup", async ({ page }) => {
    const result = await page.evaluate(() => {
      const { createRuntime, Patterns } = window.VarpulisTestHarness;

      const runtime = createRuntime({
        patterns: [Patterns.tokenVelocity({ baseline_window_steps: 5, spike_multiplier: 2.0 })],
        cooldown_ms: 0,
      });

      const detections: any[] = [];

      // Only 4 steps (baseline needs 5) — no detection even with high tokens
      for (let i = 0; i < 4; i++) {
        runtime.observe({ timestamp: 1000 + i * 1000, event_type: { type: "StepStart", step_number: i } });
        runtime.observe({
          timestamp: 1100 + i * 1000,
          event_type: { type: "LlmCall", model: "test", input_tokens: 5000, output_tokens: 5000, cost_usd: 1 },
        });
        const d = runtime.observe({
          timestamp: 1200 + i * 1000,
          event_type: { type: "StepEnd", step_number: i, produced_output: false },
        });
        detections.push(...d);
      }

      return { totalDetections: detections.length };
    });

    expect(result.totalDetections).toBe(0);
  });
});
