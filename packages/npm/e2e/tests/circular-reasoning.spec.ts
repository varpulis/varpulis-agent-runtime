import { test, expect } from "@playwright/test";

test.describe("Circular Reasoning Detection", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => window.VarpulisTestHarness?.ready);
  });

  test("detects agent stuck in search-read-search-read cycle", async ({ page }) => {
    const result = await page.evaluate(() => {
      const { createRuntime, Patterns, hashParams } = window.VarpulisTestHarness;

      const runtime = createRuntime({
        patterns: [Patterns.circularReasoning({ max_cycle_length: 4, min_cycle_repetitions: 2 })],
        cooldown_ms: 0,
      });

      const detections: any[] = [];

      // Agent alternates: search → read → search → read (cycle detected)
      const tools = ["search", "read", "search", "read"];
      for (let i = 0; i < tools.length; i++) {
        const d = runtime.observe({
          timestamp: 1000000 + i * 1000,
          event_type: {
            type: "ToolCall",
            name: tools[i],
            params_hash: hashParams({ step: i }),
            duration_ms: 200,
          },
        });
        detections.push(...d);
      }

      return {
        totalDetections: detections.length,
        detection: detections[0],
      };
    });

    // SASE Kleene closure may find multiple cycle matches in the sequence.
    expect(result.totalDetections).toBeGreaterThanOrEqual(1);
    expect(result.detection.pattern_name).toBe("circular_reasoning");
    expect(result.detection.severity).toBe("warning");
    expect(result.detection.details.cycle_length).toBe(2);
  });

  // The SASE engine with SkipTillAnyMatch can find A->B->A->B cycles even
  // within A->B->C->A->B->C by skipping the C events. This is correct CEP
  // behavior — the engine detects the repeating subsequence.
  test("detects cycle within three-step repeating sequence (SASE skip-till-any)", async ({
    page,
  }) => {
    const result = await page.evaluate(() => {
      const { createRuntime, Patterns, hashParams } = window.VarpulisTestHarness;

      const runtime = createRuntime({
        patterns: [Patterns.circularReasoning({ max_cycle_length: 4, min_cycle_repetitions: 2 })],
        cooldown_ms: 0,
      });

      const detections: any[] = [];
      // A->B->C->A->B->C: SASE finds plan->search->plan->search by skipping write
      const tools = ["plan", "search", "write", "plan", "search", "write"];

      for (let i = 0; i < tools.length; i++) {
        const d = runtime.observe({
          timestamp: 1000000 + i * 1000,
          event_type: {
            type: "ToolCall",
            name: tools[i],
            params_hash: hashParams({ i }),
            duration_ms: 100,
          },
        });
        detections.push(...d);
      }

      return {
        totalDetections: detections.length,
      };
    });

    // SASE with SkipTillAnyMatch detects plan->search->plan->search within the sequence.
    expect(result.totalDetections).toBeGreaterThanOrEqual(1);
  });

  test("no detection with diverse tool sequence", async ({ page }) => {
    const result = await page.evaluate(() => {
      const { createRuntime, Patterns, hashParams } = window.VarpulisTestHarness;

      const runtime = createRuntime({
        patterns: [Patterns.circularReasoning({ max_cycle_length: 4, min_cycle_repetitions: 2 })],
        cooldown_ms: 0,
      });

      const detections: any[] = [];
      const tools = ["plan", "search", "read", "write", "verify", "deploy", "notify", "done"];

      for (let i = 0; i < tools.length; i++) {
        const d = runtime.observe({
          timestamp: 1000000 + i * 1000,
          event_type: {
            type: "ToolCall",
            name: tools[i],
            params_hash: hashParams({ i }),
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
