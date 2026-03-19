import { test, expect } from "@playwright/test";

test.describe("Error Spiral Detection", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => window.VarpulisTestHarness?.ready);
  });

  test("detects repeated tool failures (call-error-reformulate cycle)", async ({
    page,
  }) => {
    const result = await page.evaluate(() => {
      const { createRuntime, Patterns } = window.VarpulisTestHarness;

      const runtime = createRuntime({
        patterns: [Patterns.errorSpiral({ min_error_count: 3, window_seconds: 30 })],
        cooldown_ms: 0,
      });

      const detections: any[] = [];
      const baseTime = 1000000;

      // Simulate: agent tries different tools but they all fail
      // (e.g., API is down, permissions issue, etc.)
      const failures = [
        { name: "search_api", error: "503 Service Unavailable" },
        { name: "fetch_data", error: "Connection timeout" },
        { name: "search_api", error: "503 Service Unavailable" },
      ];

      for (let i = 0; i < failures.length; i++) {
        // Agent calls tool
        runtime.observe({
          timestamp: baseTime + i * 2000,
          event_type: { type: "ToolCall", name: failures[i].name, params_hash: i, duration_ms: 500 },
        });

        // Tool returns error
        const d = runtime.observe({
          timestamp: baseTime + i * 2000 + 500,
          event_type: {
            type: "ToolResult",
            name: failures[i].name,
            success: false,
            error: failures[i].error,
          },
        });
        detections.push(...d);
      }

      return {
        totalDetections: detections.length,
        firstDetection: detections[0],
      };
    });

    // SASE Kleene closure may produce multiple matches for the same error sequence.
    expect(result.totalDetections).toBeGreaterThanOrEqual(1);
    expect(result.firstDetection.pattern_name).toBe("error_spiral");
    expect(result.firstDetection.severity).toBe("warning");
    expect(result.firstDetection.details.error_count).toBeGreaterThanOrEqual(3);
  });

  test("successful results do NOT contribute to error count", async ({ page }) => {
    const result = await page.evaluate(() => {
      const { createRuntime, Patterns } = window.VarpulisTestHarness;

      const runtime = createRuntime({
        patterns: [Patterns.errorSpiral({ min_error_count: 3, window_seconds: 30 })],
        cooldown_ms: 0,
      });

      const detections: any[] = [];
      const baseTime = 1000000;

      // 2 errors, then a success, then 1 more error — only 3 errors but
      // the success breaks the pattern perception (though not the count)
      const results = [
        { success: false },
        { success: false },
        { success: true },
        // After this we still only need 1 more error to trigger (count=3)
      ];

      for (let i = 0; i < results.length; i++) {
        const d = runtime.observe({
          timestamp: baseTime + i * 1000,
          event_type: {
            type: "ToolResult",
            name: "search",
            success: results[i].success,
          },
        });
        detections.push(...d);
      }

      // One more error should trigger (2 previous errors + this = 3)
      const d = runtime.observe({
        timestamp: baseTime + 4000,
        event_type: { type: "ToolResult", name: "search", success: false },
      });
      detections.push(...d);

      return { totalDetections: detections.length };
    });

    // SASE may produce multiple matches across the error subsequence.
    expect(result.totalDetections).toBeGreaterThanOrEqual(1);
  });
});
