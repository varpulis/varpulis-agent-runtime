import { test, expect } from "@playwright/test";

test.describe("Mixed Scenario — Retry Storm + Stuck Agent", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => window.VarpulisTestHarness?.ready);
  });

  test("detects both patterns in a single agent run", async ({ page }) => {
    const result = await page.evaluate(() => {
      const { createRuntime, Patterns, hashParams } = window.VarpulisTestHarness;

      const runtime = createRuntime({
        patterns: [
          Patterns.retryStorm({ min_repetitions: 3, window_seconds: 10 }),
          Patterns.stuckAgent({ max_steps_without_output: 5, max_time_without_output_seconds: 9999 }),
        ],
        cooldown_ms: 0,
      });

      const allDetections: any[] = [];
      const paramsHash = hashParams({ url: "https://api.example.com/data" });
      let t = 1000000;

      // Phase 1: Agent retries the same API call 4 times (retry storm)
      for (let i = 0; i < 4; i++) {
        t += 1000;
        const d = runtime.observe({
          timestamp: t,
          event_type: {
            type: "ToolCall",
            name: "http_fetch",
            params_hash: paramsHash,
            duration_ms: 500,
          },
        });
        allDetections.push(...d);
      }

      // Phase 2: Agent gives up on the API and enters a reasoning loop (stuck agent)
      for (let i = 1; i <= 8; i++) {
        t += 2000;
        runtime.observe({
          timestamp: t,
          event_type: { type: "StepStart", step_number: i },
        });

        t += 500;
        const d = runtime.observe({
          timestamp: t,
          event_type: { type: "StepEnd", step_number: i, produced_output: false },
        });
        allDetections.push(...d);
      }

      const retryDetections = allDetections.filter((d: any) => d.pattern_name === "retry_storm");
      const stuckDetections = allDetections.filter((d: any) => d.pattern_name === "stuck_agent");

      return {
        totalDetections: allDetections.length,
        retryStormCount: retryDetections.length,
        stuckAgentCount: stuckDetections.length,
        patternNames: allDetections.map((d: any) => d.pattern_name),
        eventCount: runtime.eventCount,
      };
    });

    // SASE Kleene closure may produce different match counts than the old detector.
    expect(result.retryStormCount).toBeGreaterThanOrEqual(1);
    expect(result.stuckAgentCount).toBeGreaterThanOrEqual(1);
    expect(result.totalDetections).toBeGreaterThanOrEqual(2);
    // Both patterns should fire: retry storm and stuck agent
    expect(result.patternNames).toContain("retry_storm");
    expect(result.patternNames).toContain("stuck_agent");
    expect(result.eventCount).toBe(20); // 4 ToolCall + 8 StepStart + 8 StepEnd
  });

  test("reset clears state and allows re-detection", async ({ page }) => {
    const result = await page.evaluate(() => {
      const { createRuntime, Patterns, hashParams } = window.VarpulisTestHarness;

      const runtime = createRuntime({
        patterns: [Patterns.retryStorm({ min_repetitions: 3, window_seconds: 10 })],
        cooldown_ms: 0,
      });

      const paramsHash = hashParams({ q: "test" });
      let t = 1000000;

      // Trigger a retry storm
      for (let i = 0; i < 3; i++) {
        t += 1000;
        runtime.observe({
          timestamp: t,
          event_type: { type: "ToolCall", name: "search", params_hash: paramsHash, duration_ms: 100 },
        });
      }

      const countBefore = runtime.eventCount;

      // Reset
      runtime.reset();
      const countAfter = runtime.eventCount;

      // Same events again — should trigger again because state was cleared
      const detections: any[] = [];
      t = 2000000;
      for (let i = 0; i < 3; i++) {
        t += 1000;
        const d = runtime.observe({
          timestamp: t,
          event_type: { type: "ToolCall", name: "search", params_hash: paramsHash, duration_ms: 100 },
        });
        detections.push(...d);
      }

      return {
        countBefore,
        countAfter,
        detectionsAfterReset: detections.length,
      };
    });

    expect(result.countBefore).toBe(3);
    expect(result.countAfter).toBe(0);
    // After reset, the pattern should fire again for the same events.
    expect(result.detectionsAfterReset).toBeGreaterThanOrEqual(1);
  });
});
