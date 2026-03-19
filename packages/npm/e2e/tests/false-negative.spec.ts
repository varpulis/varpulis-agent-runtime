import { test, expect } from "@playwright/test";

test.describe("False Negative — Healthy Agent Behavior", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => window.VarpulisTestHarness?.ready);
  });

  test("normal diverse workflow produces zero detections", async ({ page }) => {
    const result = await page.evaluate(() => {
      const { createRuntime, Patterns, hashParams } = window.VarpulisTestHarness;

      const runtime = createRuntime({
        patterns: [
          Patterns.retryStorm({ min_repetitions: 3, window_seconds: 10 }),
          Patterns.stuckAgent({ max_steps_without_output: 15, max_time_without_output_seconds: 120 }),
        ],
        cooldown_ms: 0,
      });

      const detections: any[] = [];
      let t = 1000000;

      // Simulate a healthy agent workflow:
      // 1. Agent plans with LLM
      t += 1000;
      runtime.observe({ timestamp: t, event_type: { type: "LlmCall", model: "claude-sonnet-4-20250514", input_tokens: 500, output_tokens: 200, cost_usd: 0.003 } });
      t += 500;
      runtime.observe({ timestamp: t, event_type: { type: "LlmResponse", model: "claude-sonnet-4-20250514", has_tool_use: true } });

      // 2. Agent calls different tools with different params
      const tools = [
        { name: "search", params: { query: "machine learning" } },
        { name: "read_file", params: { path: "/src/main.rs" } },
        { name: "search", params: { query: "neural networks" } },  // same tool, different params
        { name: "write_file", params: { path: "/output.txt", content: "results" } },
        { name: "search", params: { query: "deep learning" } },  // 3rd search but all different
      ];

      for (const tool of tools) {
        t += 2000;
        runtime.observe({ timestamp: t, event_type: { type: "StepStart", step_number: 0 } });

        t += 100;
        const d = runtime.observe({
          timestamp: t,
          event_type: { type: "ToolCall", name: tool.name, params_hash: hashParams(tool.params), duration_ms: 300 },
        });
        detections.push(...d);

        t += 300;
        runtime.observe({ timestamp: t, event_type: { type: "ToolResult", name: tool.name, success: true } });

        t += 100;
        const d2 = runtime.observe({ timestamp: t, event_type: { type: "StepEnd", step_number: 0, produced_output: false } });
        detections.push(...d2);
      }

      // 3. Agent produces final answer
      t += 1000;
      const d = runtime.observe({ timestamp: t, event_type: { type: "FinalAnswer", content_length: 1500 } });
      detections.push(...d);

      return {
        totalDetections: detections.length,
        eventCount: runtime.eventCount,
      };
    });

    expect(result.totalDetections).toBe(0);
    expect(result.eventCount).toBeGreaterThan(0);
  });

  test("just below retry threshold produces no detection", async ({ page }) => {
    const result = await page.evaluate(() => {
      const { createRuntime, Patterns, hashParams } = window.VarpulisTestHarness;

      const runtime = createRuntime({
        patterns: [Patterns.retryStorm({ min_repetitions: 3, window_seconds: 10 })],
        cooldown_ms: 0,
      });

      const detections: any[] = [];
      const paramsHash = hashParams({ query: "test" });

      // Only 2 identical calls — one below the threshold of 3
      for (let i = 0; i < 2; i++) {
        const d = runtime.observe({
          timestamp: 1000000 + i * 1000,
          event_type: { type: "ToolCall", name: "search", params_hash: paramsHash, duration_ms: 100 },
        });
        detections.push(...d);
      }

      return { totalDetections: detections.length };
    });

    expect(result.totalDetections).toBe(0);
  });

  test("just below stuck threshold produces no detection", async ({ page }) => {
    const result = await page.evaluate(() => {
      const { createRuntime, Patterns } = window.VarpulisTestHarness;

      const runtime = createRuntime({
        patterns: [Patterns.stuckAgent({ max_steps_without_output: 15, max_time_without_output_seconds: 9999 })],
        cooldown_ms: 0,
      });

      const detections: any[] = [];

      // 14 steps without output — one below the threshold of 15
      for (let i = 1; i <= 14; i++) {
        const d = runtime.observe({
          timestamp: 1000000 + i * 1000,
          event_type: { type: "StepEnd", step_number: i, produced_output: false },
        });
        detections.push(...d);
      }

      return { totalDetections: detections.length };
    });

    expect(result.totalDetections).toBe(0);
  });
});
