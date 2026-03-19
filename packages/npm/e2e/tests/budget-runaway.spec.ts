import { test, expect } from "@playwright/test";

test.describe("Budget Runaway Detection", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => window.VarpulisTestHarness?.ready);
  });

  test("warns at 80% and errors at 100% of cost threshold", async ({ page }) => {
    const result = await page.evaluate(() => {
      const { createRuntime, Patterns } = window.VarpulisTestHarness;

      const runtime = createRuntime({
        patterns: [Patterns.budgetRunaway({ max_cost_usd: 1.0, max_tokens: 999999, window_seconds: 60 })],
        cooldown_ms: 0,
      });

      const detections: any[] = [];
      const baseTime = 1000000;

      // Simulate: agent makes expensive LLM calls
      // 5 calls at $0.20 each: $0.80 triggers warning, $1.00 triggers error
      for (let i = 0; i < 5; i++) {
        const d = runtime.observe({
          timestamp: baseTime + i * 2000,
          event_type: {
            type: "LlmCall",
            model: "claude-sonnet-4-20250514",
            input_tokens: 1000,
            output_tokens: 500,
            cost_usd: 0.20,
          },
        });
        detections.push(...d);
      }

      return {
        totalDetections: detections.length,
        severities: detections.map((d: any) => d.severity),
        patternNames: detections.map((d: any) => d.pattern_name),
      };
    });

    expect(result.totalDetections).toBe(2);
    expect(result.severities).toContain("warning");
    expect(result.severities).toContain("error");
    expect(result.patternNames.every((n: string) => n === "budget_runaway")).toBe(true);
  });

  test("warns at 80% of token threshold", async ({ page }) => {
    const result = await page.evaluate(() => {
      const { createRuntime, Patterns } = window.VarpulisTestHarness;

      const runtime = createRuntime({
        patterns: [Patterns.budgetRunaway({ max_cost_usd: 999, max_tokens: 10000, window_seconds: 60 })],
        cooldown_ms: 0,
      });

      const detections: any[] = [];

      // 4 calls at 2000 tokens each = 8000 tokens (80% of 10000)
      for (let i = 0; i < 4; i++) {
        const d = runtime.observe({
          timestamp: 1000000 + i * 1000,
          event_type: {
            type: "LlmCall",
            model: "test",
            input_tokens: 1000,
            output_tokens: 1000,
            cost_usd: 0.001,
          },
        });
        detections.push(...d);
      }

      return {
        totalDetections: detections.length,
        severity: detections[0]?.severity,
      };
    });

    expect(result.totalDetections).toBe(1);
    expect(result.severity).toBe("warning");
  });

  test("no detection under threshold", async ({ page }) => {
    const result = await page.evaluate(() => {
      const { createRuntime, Patterns } = window.VarpulisTestHarness;

      const runtime = createRuntime({
        patterns: [Patterns.budgetRunaway({ max_cost_usd: 10.0, max_tokens: 1000000, window_seconds: 60 })],
        cooldown_ms: 0,
      });

      const detections: any[] = [];

      // Low-cost calls well under threshold
      for (let i = 0; i < 5; i++) {
        const d = runtime.observe({
          timestamp: 1000000 + i * 1000,
          event_type: {
            type: "LlmCall",
            model: "test",
            input_tokens: 100,
            output_tokens: 50,
            cost_usd: 0.01,
          },
        });
        detections.push(...d);
      }

      return { totalDetections: detections.length };
    });

    expect(result.totalDetections).toBe(0);
  });
});
