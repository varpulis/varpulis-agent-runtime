import type { AgentEvent, Detection } from "./types.js";
import type { VarpulisAgentRuntime } from "./runtime.js";
import { hashParams } from "./hash.js";

/** An MCP tool_use request. */
export interface McpToolUse {
  name: string;
  arguments: Record<string, unknown>;
  id?: string;
}

/** An MCP tool_result response. */
export interface McpToolResult {
  tool_use_id?: string;
  name: string;
  content: unknown;
  is_error?: boolean;
}

/**
 * Thin adapter that translates MCP protocol messages into AgentEvents
 * and pushes them through a VarpulisAgentRuntime.
 */
export class McpAdapter {
  private runtime: VarpulisAgentRuntime;

  constructor(runtime: VarpulisAgentRuntime) {
    this.runtime = runtime;
  }

  /** Process an MCP tool_use message. */
  processToolUse(msg: McpToolUse): Detection[] {
    const event: AgentEvent = {
      timestamp: Date.now(),
      event_type: {
        type: "ToolCall",
        name: msg.name,
        params_hash: hashParams(msg.arguments),
        duration_ms: 0,
      },
    };
    return this.runtime.observe(event);
  }

  /** Process an MCP tool_result message. */
  processToolResult(msg: McpToolResult): Detection[] {
    const event: AgentEvent = {
      timestamp: Date.now(),
      event_type: {
        type: "ToolResult",
        name: msg.name,
        success: !msg.is_error,
        error: msg.is_error ? String(msg.content) : undefined,
      },
    };
    return this.runtime.observe(event);
  }
}
