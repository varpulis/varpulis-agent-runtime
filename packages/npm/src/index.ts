export { VarpulisAgentRuntime } from "./runtime.js";
export { Patterns } from "./patterns.js";
export { McpAdapter } from "./mcp.js";
export { hashParams, fnv1a } from "./hash.js";
export { VarpulisLangChainHandler, VarpulisKillError } from "./integrations/langchain.js";
export { createVarpulisOpenAIHooks } from "./integrations/openai.js";
export type { VarpulisOpenAIHooks } from "./integrations/openai.js";
export type {
  AgentEvent,
  AgentEventType,
  BudgetRunawayConfig,
  CircularReasoningConfig,
  Detection,
  ErrorSpiralConfig,
  PatternConfig,
  RetryStormConfig,
  RuntimeConfig,
  StuckAgentConfig,
  TargetedFailureConfig,
  TokenVelocityConfig,
} from "./types.js";
export type { McpToolUse, McpToolResult } from "./mcp.js";
export { ClaudeCodeAdapter } from "./adapters/claude-code.js";
export type { ClaudeCodeAdapterConfig } from "./adapters/claude-code.js";
export { HealthScoreTracker } from "./health.js";
export { DetectionHistory } from "./history.js";
export { ConvergentFailureTracker } from "./convergent.js";
export type {
  ConvergentFailureConfig,
  StaleGuardrailProposal,
  TargetFailureRecord,
  SessionEvidence,
} from "./convergent.js";
export { proposeRule, isDuplicate, applyRule, evaluate } from "./learn/index.js";
export type { LearnProposal } from "./learn/index.js";
export { proposeHook, mergeHookConfig } from "./learn/index.js";
export type { HookProposal, HookConfig } from "./learn/index.js";
export { proposeCommand, isCommandDuplicate } from "./learn/index.js";
export type { CommandProposal } from "./learn/index.js";
