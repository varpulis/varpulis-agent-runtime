import { test, expect } from "@playwright/test";

test.describe("Retry Storm Detection", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => window.VarpulisTestHarness?.ready);
  });

  test("detects an agent retrying the same API call with identical params", async ({
    page,
  }) => {
    const result = await page.evaluate(() => {
      const { createRuntime, Patterns, hashParams } = window.VarpulisTestHarness;

      const runtime = createRuntime({
        patterns: [Patterns.retryStorm({ min_repetitions: 3, window_seconds: 10 })],
        cooldown_ms: 0,
      });

      const detections: any[] = [];
      const paramsHash = hashParams({ query: "weather in paris" });
      const baseTime = 1000000;

      // Simulate: LLM agent calls search_api 5 times with the same query
      // (e.g., tool keeps returning an error and the LLM retries blindly)
      for (let i = 0; i < 5; i++) {
        const d = runtime.observe({
          timestamp: baseTime + i * 1000,
          event_type: {
            type: "ToolCall",
            name: "search_api",
            params_hash: paramsHash,
            duration_ms: 200,
          },
        });
        detections.push(...d);
      }

      return {
        totalDetections: detections.length,
        firstDetection: detections[0],
        eventCount: runtime.eventCount,
      };
    });

    // Calls 1-2: below threshold. Calls 3,4,5: each triggers (cooldown=0).
    expect(result.totalDetections).toBe(3);
    expect(result.firstDetection.pattern_name).toBe("retry_storm");
    expect(result.firstDetection.severity).toBe("warning");
    expect(result.firstDetection.details.tool_name).toBe("search_api");
    expect(result.firstDetection.details.count).toBeGreaterThanOrEqual(3);
    expect(result.eventCount).toBe(5);
  });

  test("does NOT trigger when params differ each time", async ({ page }) => {
    const result = await page.evaluate(() => {
      const { createRuntime, Patterns, hashParams } = window.VarpulisTestHarness;

      const runtime = createRuntime({
        patterns: [Patterns.retryStorm({ min_repetitions: 3, window_seconds: 10 })],
        cooldown_ms: 0,
      });

      const detections: any[] = [];
      const baseTime = 1000000;
      const queries = ["weather paris", "news today", "stock prices", "recipe pasta", "flights NYC"];

      // Agent calls the same tool but with different queries each time — healthy behavior
      for (let i = 0; i < 5; i++) {
        const d = runtime.observe({
          timestamp: baseTime + i * 1000,
          event_type: {
            type: "ToolCall",
            name: "search_api",
            params_hash: hashParams({ query: queries[i] }),
            duration_ms: 150,
          },
        });
        detections.push(...d);
      }

      return { totalDetections: detections.length };
    });

    expect(result.totalDetections).toBe(0);
  });

  test("does NOT trigger when calls are spread across time", async ({ page }) => {
    const result = await page.evaluate(() => {
      const { createRuntime, Patterns, hashParams } = window.VarpulisTestHarness;

      const runtime = createRuntime({
        patterns: [Patterns.retryStorm({ min_repetitions: 3, window_seconds: 5 })],
        cooldown_ms: 0,
      });

      const detections: any[] = [];
      const paramsHash = hashParams({ query: "weather" });

      // 3 identical calls but each 6 seconds apart — outside the 5s window
      for (let i = 0; i < 3; i++) {
        const d = runtime.observe({
          timestamp: 1000000 + i * 6000,
          event_type: {
            type: "ToolCall",
            name: "search_api",
            params_hash: paramsHash,
            duration_ms: 100,
          },
        });
        detections.push(...d);
      }

      return { totalDetections: detections.length };
    });

    expect(result.totalDetections).toBe(0);
  });
});
