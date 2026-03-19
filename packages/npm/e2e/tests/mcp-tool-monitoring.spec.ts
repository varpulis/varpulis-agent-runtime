import { test, expect } from "@playwright/test";

test.describe("MCP Tool Monitoring", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => window.VarpulisTestHarness?.ready);
  });

  test("detects retry storm through MCP tool_use messages", async ({ page }) => {
    const result = await page.evaluate(() => {
      const { createRuntime, createMcpAdapter, Patterns } = window.VarpulisTestHarness;

      const runtime = createRuntime({
        patterns: [Patterns.retryStorm({ min_repetitions: 3, window_seconds: 10 })],
        cooldown_ms: 0,
      });
      const adapter = createMcpAdapter(runtime);

      const detections: any[] = [];

      // Simulate: MCP client calls file_search 4 times with identical arguments
      // (real scenario: agent keeps asking MCP server to search for a file that doesn't exist)
      for (let i = 0; i < 4; i++) {
        const d = adapter.processToolUse({
          name: "file_search",
          arguments: { path: "/src", pattern: "*.rs" },
          id: `call_${i}`,
        });
        detections.push(...d);
      }

      return {
        totalDetections: detections.length,
        firstDetection: detections[0],
        eventCount: runtime.eventCount,
      };
    });

    // 3rd and 4th calls trigger (identical params_hash via hashParams)
    expect(result.totalDetections).toBe(2);
    expect(result.firstDetection.pattern_name).toBe("retry_storm");
    expect(result.firstDetection.details.tool_name).toBe("file_search");
    expect(result.eventCount).toBe(4);
  });

  test("processes tool_result messages without false positives", async ({ page }) => {
    const result = await page.evaluate(() => {
      const { createRuntime, createMcpAdapter, Patterns } = window.VarpulisTestHarness;

      const runtime = createRuntime({
        patterns: [Patterns.retryStorm({ min_repetitions: 3, window_seconds: 10 })],
        cooldown_ms: 0,
      });
      const adapter = createMcpAdapter(runtime);

      const detections: any[] = [];

      // Simulate: MCP tool results coming back (errors) — these are ToolResult events,
      // not ToolCall events, so retry storm should NOT trigger
      for (let i = 0; i < 5; i++) {
        const d = adapter.processToolResult({
          name: "file_search",
          content: "File not found",
          is_error: true,
        });
        detections.push(...d);
      }

      return { totalDetections: detections.length };
    });

    expect(result.totalDetections).toBe(0);
  });

  test("mixed MCP tool_use and tool_result flow", async ({ page }) => {
    const result = await page.evaluate(() => {
      const { createRuntime, createMcpAdapter, Patterns } = window.VarpulisTestHarness;

      const runtime = createRuntime({
        patterns: [Patterns.retryStorm({ min_repetitions: 3, window_seconds: 10 })],
        cooldown_ms: 0,
      });
      const adapter = createMcpAdapter(runtime);

      const detections: any[] = [];

      // Realistic MCP flow: call → error → call → error → call → error
      for (let i = 0; i < 4; i++) {
        const d1 = adapter.processToolUse({
          name: "read_file",
          arguments: { path: "/etc/config.yaml" },
        });
        detections.push(...d1);

        const d2 = adapter.processToolResult({
          name: "read_file",
          content: "Permission denied",
          is_error: true,
        });
        detections.push(...d2);
      }

      return {
        totalDetections: detections.length,
        eventCount: runtime.eventCount,
      };
    });

    // 4 tool_use + 4 tool_result = 8 events
    // Retry storm fires on 3rd and 4th tool_use
    expect(result.totalDetections).toBe(2);
    expect(result.eventCount).toBe(8);
  });
});
