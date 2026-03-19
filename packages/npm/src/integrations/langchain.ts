/**
 * LangChain integration for Varpulis Agent Runtime.
 *
 * Provides a callback handler that translates LangChain events into
 * AgentEvents and pushes them through the runtime for pattern detection.
 *
 * Usage:
 *   import { VarpulisLangChainHandler } from '@varpulis/agent-runtime/langchain';
 *   const handler = new VarpulisLangChainHandler(runtime);
 *   const agent = createAgent({ callbacks: [handler] });
 */
import type { VarpulisAgentRuntime } from "../runtime.js";
import type { Detection } from "../types.js";
import { hashParams } from "../hash.js";

/** Thrown when a detection with action "kill" fires. Catch this to handle agent termination. */
export class VarpulisKillError extends Error {
  readonly detection: Detection;
  constructor(detection: Detection) {
    super(`[Varpulis Kill] ${detection.pattern_name}: ${detection.message}`);
    this.name = "VarpulisKillError";
    this.detection = detection;
  }
}

/**
 * LangChain callback handler that translates LangChain events into
 * Varpulis AgentEvents for real-time behavioral pattern detection.
 *
 * Implements the LangChain BaseCallbackHandler interface methods
 * without importing @langchain/core (it's a peer dependency).
 */
export class VarpulisLangChainHandler {
  readonly name = "VarpulisLangChainHandler";
  private runtime: VarpulisAgentRuntime;
  private stepCounter = 0;
  /** Map runId → tool name for correlating start/end events. */
  private toolRuns = new Map<string, string>();
  /** Map runId → start timestamp for duration tracking. */
  private toolStartTimes = new Map<string, number>();

  /** Whether to throw VarpulisKillError on kill detections. Default: true. */
  readonly enforceKill: boolean;

  constructor(runtime: VarpulisAgentRuntime, options?: { enforceKill?: boolean }) {
    this.runtime = runtime;
    this.enforceKill = options?.enforceKill ?? true;
  }

  private checkKill(detections: Detection[]): Detection[] {
    if (this.enforceKill) {
      const kill = detections.find((d) => d.action === "kill");
      if (kill) throw new VarpulisKillError(kill);
    }
    return detections;
  }

  handleToolStart(
    tool: { name?: string; id?: string[] },
    input: string,
    runId: string,
  ): Detection[] {
    const toolName = tool.name ?? "unknown_tool";
    this.toolRuns.set(runId, toolName);
    this.toolStartTimes.set(runId, Date.now());

    let paramsHash = 0;
    try {
      const parsed = typeof input === "string" ? JSON.parse(input) : input;
      paramsHash = hashParams(
        typeof parsed === "object" && parsed !== null ? parsed : { input: String(input) },
      );
    } catch {
      paramsHash = hashParams({ input: String(input) });
    }

    return this.checkKill(this.runtime.observe({
      timestamp: Date.now(),
      event_type: {
        type: "ToolCall",
        name: toolName,
        params_hash: paramsHash,
        duration_ms: 0,
      },
    }));
  }

  handleToolEnd(output: string, runId: string): Detection[] {
    const toolName = this.toolRuns.get(runId) ?? "unknown_tool";
    this.toolRuns.delete(runId);
    this.toolStartTimes.delete(runId);

    return this.checkKill(this.runtime.observe({
      timestamp: Date.now(),
      event_type: {
        type: "ToolResult",
        name: toolName,
        success: true,
      },
    }));
  }

  handleToolError(error: Error | string, runId: string): Detection[] {
    const toolName = this.toolRuns.get(runId) ?? "unknown_tool";
    this.toolRuns.delete(runId);
    this.toolStartTimes.delete(runId);

    const errorMsg = typeof error === "string" ? error : error.message;

    return this.checkKill(this.runtime.observe({
      timestamp: Date.now(),
      event_type: {
        type: "ToolResult",
        name: toolName,
        success: false,
        error: errorMsg,
      },
    }));
  }

  handleLLMEnd(
    output: {
      llmOutput?: { tokenUsage?: { promptTokens?: number; completionTokens?: number } };
      generations?: Array<Array<{ message?: { tool_calls?: unknown[] } }>>;
    },
    runId: string,
  ): Detection[] {
    const usage = output.llmOutput?.tokenUsage;
    const inputTokens = usage?.promptTokens ?? 0;
    const outputTokens = usage?.completionTokens ?? 0;

    // Check if any generation has tool calls.
    const hasToolUse =
      output.generations?.some((gen) =>
        gen.some((g) => {
          const calls = g.message?.tool_calls;
          return Array.isArray(calls) && calls.length > 0;
        }),
      ) ?? false;

    const detections: Detection[] = [];

    // Emit LlmCall with real token counts.
    detections.push(
      ...this.runtime.observe({
        timestamp: Date.now(),
        event_type: {
          type: "LlmCall",
          model: "langchain",
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cost_usd: 0,
        },
      }),
    );

    // Emit LlmResponse.
    detections.push(
      ...this.runtime.observe({
        timestamp: Date.now(),
        event_type: {
          type: "LlmResponse",
          model: "langchain",
          has_tool_use: hasToolUse,
        },
      }),
    );

    return this.checkKill(detections);
  }

  handleChainStart(
    _chain: { name?: string },
    _inputs: Record<string, unknown>,
    _runId: string,
  ): Detection[] {
    this.stepCounter++;
    return this.checkKill(this.runtime.observe({
      timestamp: Date.now(),
      event_type: {
        type: "StepStart",
        step_number: this.stepCounter,
      },
    }));
  }

  handleChainEnd(
    outputs: Record<string, unknown>,
    _runId: string,
  ): Detection[] {
    const producedOutput =
      outputs != null &&
      Object.keys(outputs).length > 0 &&
      Object.values(outputs).some((v) => v != null && v !== "");

    return this.checkKill(this.runtime.observe({
      timestamp: Date.now(),
      event_type: {
        type: "StepEnd",
        step_number: this.stepCounter,
        produced_output: producedOutput,
      },
    }));
  }
}
