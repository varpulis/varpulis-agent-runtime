import { describe, it, expect, vi } from "vitest";
import { McpAdapter } from "../mcp.js";
import type { VarpulisAgentRuntime } from "../runtime.js";
import type { AgentEvent, Detection } from "../types.js";

function mockRuntime() {
  const observed: AgentEvent[] = [];
  const runtime = {
    observe(event: AgentEvent): Detection[] {
      observed.push(event);
      return [];
    },
  } as unknown as VarpulisAgentRuntime;
  return { runtime, observed };
}

describe("McpAdapter", () => {
  it("translates tool_use to ToolCall event", () => {
    const { runtime, observed } = mockRuntime();
    const adapter = new McpAdapter(runtime);

    adapter.processToolUse({
      name: "search",
      arguments: { query: "weather in paris" },
    });

    expect(observed).toHaveLength(1);
    expect(observed[0].event_type.type).toBe("ToolCall");
    if (observed[0].event_type.type === "ToolCall") {
      expect(observed[0].event_type.name).toBe("search");
      expect(observed[0].event_type.params_hash).toBeTypeOf("number");
    }
  });

  it("translates tool_result to ToolResult event", () => {
    const { runtime, observed } = mockRuntime();
    const adapter = new McpAdapter(runtime);

    adapter.processToolResult({
      name: "search",
      content: "some result",
      is_error: false,
    });

    expect(observed).toHaveLength(1);
    expect(observed[0].event_type.type).toBe("ToolResult");
    if (observed[0].event_type.type === "ToolResult") {
      expect(observed[0].event_type.name).toBe("search");
      expect(observed[0].event_type.success).toBe(true);
    }
  });

  it("translates error results correctly", () => {
    const { runtime, observed } = mockRuntime();
    const adapter = new McpAdapter(runtime);

    adapter.processToolResult({
      name: "search",
      content: "not found",
      is_error: true,
    });

    expect(observed).toHaveLength(1);
    if (observed[0].event_type.type === "ToolResult") {
      expect(observed[0].event_type.success).toBe(false);
      expect(observed[0].event_type.error).toBe("not found");
    }
  });

  it("computes consistent params_hash for same arguments", () => {
    const { runtime, observed } = mockRuntime();
    const adapter = new McpAdapter(runtime);

    adapter.processToolUse({ name: "search", arguments: { q: "a" } });
    adapter.processToolUse({ name: "search", arguments: { q: "a" } });

    const h1 = (observed[0].event_type as any).params_hash;
    const h2 = (observed[1].event_type as any).params_hash;
    expect(h1).toBe(h2);
  });
});
