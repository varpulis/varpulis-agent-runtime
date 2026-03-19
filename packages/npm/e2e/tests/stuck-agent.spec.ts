import { test, expect } from "@playwright/test";

test.describe("Stuck Agent Detection", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => window.VarpulisTestHarness?.ready);
  });

  test("detects an agent stuck in a thinking loop without producing output", async ({
    page,
  }) => {
    const result = await page.evaluate(() => {
      const { createRuntime, Patterns } = window.VarpulisTestHarness;

      const runtime = createRuntime({
        patterns: [Patterns.stuckAgent({ max_steps_without_output: 5, max_time_without_output_seconds: 9999 })],
        cooldown_ms: 0,
      });

      const detections: any[] = [];
      const baseTime = 1000000;

      // Simulate: agent runs 10 steps of "reasoning" but never answers
      for (let i = 1; i <= 10; i++) {
        runtime.observe({
          timestamp: baseTime + i * 1000,
          event_type: { type: "StepStart", step_number: i },
        });

        const d = runtime.observe({
          timestamp: baseTime + i * 1000 + 500,
          event_type: { type: "StepEnd", step_number: i, produced_output: false },
        });
        detections.push(...d);
      }

      return {
        totalDetections: detections.length,
        firstDetection: detections[0],
        eventCount: runtime.eventCount,
      };
    });

    // Fires once on step 5 (the detector's `fired` flag prevents repeats)
    expect(result.totalDetections).toBe(1);
    expect(result.firstDetection.pattern_name).toBe("stuck_agent");
    expect(result.firstDetection.severity).toBe("error");
    expect(result.firstDetection.details.steps_since_output).toBeGreaterThanOrEqual(5);
    expect(result.eventCount).toBe(20); // 10 StepStart + 10 StepEnd
  });

  test("detects an agent stuck by time even with few steps", async ({ page }) => {
    const result = await page.evaluate(() => {
      const { createRuntime, Patterns } = window.VarpulisTestHarness;

      const runtime = createRuntime({
        patterns: [Patterns.stuckAgent({ max_steps_without_output: 9999, max_time_without_output_seconds: 60 })],
        cooldown_ms: 0,
      });

      const detections: any[] = [];

      // Step 1 at t=0
      runtime.observe({
        timestamp: 1000000,
        event_type: { type: "StepEnd", step_number: 1, produced_output: false },
      });

      // Step 2 at t=90s — well past the 60s threshold
      const d = runtime.observe({
        timestamp: 1000000 + 90_000,
        event_type: { type: "StepEnd", step_number: 2, produced_output: false },
      });
      detections.push(...d);

      return {
        totalDetections: detections.length,
        detection: detections[0],
      };
    });

    expect(result.totalDetections).toBe(1);
    expect(result.detection.pattern_name).toBe("stuck_agent");
    expect(result.detection.details.seconds_since_output).toBeGreaterThanOrEqual(60);
  });

  test("resets when agent produces output", async ({ page }) => {
    const result = await page.evaluate(() => {
      const { createRuntime, Patterns } = window.VarpulisTestHarness;

      const runtime = createRuntime({
        patterns: [Patterns.stuckAgent({ max_steps_without_output: 3, max_time_without_output_seconds: 9999 })],
        cooldown_ms: 0,
      });

      const detections: any[] = [];
      const baseTime = 1000000;

      // 2 empty steps
      for (let i = 1; i <= 2; i++) {
        runtime.observe({ timestamp: baseTime + i * 1000, event_type: { type: "StepEnd", step_number: i, produced_output: false } });
      }

      // Agent produces a final answer — resets the counter
      runtime.observe({
        timestamp: baseTime + 3000,
        event_type: { type: "FinalAnswer", content_length: 500 },
      });

      // 2 more empty steps — below threshold again, no detection
      for (let i = 4; i <= 5; i++) {
        const d = runtime.observe({ timestamp: baseTime + i * 1000, event_type: { type: "StepEnd", step_number: i, produced_output: false } });
        detections.push(...d);
      }

      return { totalDetections: detections.length };
    });

    expect(result.totalDetections).toBe(0);
  });
});
