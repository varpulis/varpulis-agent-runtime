/**
 * OpenAI Agents SDK integration for Varpulis Agent Runtime.
 *
 * Provides hooks that translate OpenAI Agent SDK events into
 * AgentEvents for pattern detection.
 *
 * Usage:
 *   import { createVarpulisOpenAIHooks } from '@varpulis/agent-runtime/openai';
 *   const hooks = createVarpulisOpenAIHooks(runtime);
 *   const agent = new Agent({ hooks });
 */
import type { VarpulisAgentRuntime } from "../runtime.js";
import type { Detection } from "../types.js";
import { hashParams } from "../hash.js";

export interface VarpulisOpenAIHooks {
  onToolStart: (toolName: string, toolInput: Record<string, unknown>) => Detection[];
  onToolEnd: (toolName: string, toolOutput: string, isError?: boolean) => Detection[];
  onStepStart: (stepNumber: number) => Detection[];
  onStepEnd: (stepNumber: number, producedOutput: boolean) => Detection[];
  onLlmUsage: (inputTokens: number, outputTokens: number, model?: string) => Detection[];
}

/**
 * Create hooks for the OpenAI Agents SDK that feed events to
 * a Varpulis runtime for behavioral pattern detection.
 */
export function createVarpulisOpenAIHooks(
  runtime: VarpulisAgentRuntime,
): VarpulisOpenAIHooks {
  return {
    onToolStart(toolName: string, toolInput: Record<string, unknown>): Detection[] {
      return runtime.observe({
        timestamp: Date.now(),
        event_type: {
          type: "ToolCall",
          name: toolName,
          params_hash: hashParams(toolInput),
          duration_ms: 0,
        },
      });
    },

    onToolEnd(toolName: string, toolOutput: string, isError = false): Detection[] {
      return runtime.observe({
        timestamp: Date.now(),
        event_type: {
          type: "ToolResult",
          name: toolName,
          success: !isError,
          error: isError ? toolOutput : undefined,
        },
      });
    },

    onStepStart(stepNumber: number): Detection[] {
      return runtime.observe({
        timestamp: Date.now(),
        event_type: {
          type: "StepStart",
          step_number: stepNumber,
        },
      });
    },

    onStepEnd(stepNumber: number, producedOutput: boolean): Detection[] {
      return runtime.observe({
        timestamp: Date.now(),
        event_type: {
          type: "StepEnd",
          step_number: stepNumber,
          produced_output: producedOutput,
        },
      });
    },

    onLlmUsage(inputTokens: number, outputTokens: number, model = "openai"): Detection[] {
      return runtime.observe({
        timestamp: Date.now(),
        event_type: {
          type: "LlmCall",
          model,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cost_usd: 0,
        },
      });
    },
  };
}
