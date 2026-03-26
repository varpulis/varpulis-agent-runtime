import type { AgentEvent, Detection } from "../types.js";
import type { VarpulisAgentRuntime } from "../runtime.js";
import type { DetectionHistory } from "../history.js";
import type { LearnProposal } from "../learn/rules.js";
import type { ConvergentFailureTracker, StaleGuardrailProposal } from "../convergent.js";
import { evaluate } from "../learn/rules.js";
import { hashParams } from "../hash.js";

// Embedded VPL patterns from patterns/claude-code/*.vpl
const VPL_INTENT_STALL = `pattern IntentStall = SEQ(
    LlmResponse where intent_without_action == true as r1,
    LlmResponse+ where intent_without_action == true as stalls
) within 120s`;

const VPL_COMPACTION_SPIRAL = `pattern CompactionSpiral = SEQ(
    Compaction as c1,
    Compaction+ where freed_ratio < 0.15 as spiral
) within 300s`;

const VPL_CONTEXT_STARVATION = `pattern ContextStarvation = SEQ(
    Compaction as c1,
    Compaction+ where system_context_ratio > 0.70 as starved
) within 600s`;

const VPL_GIT_PUSH_VIOLATION = `pattern GitPushViolation = SEQ(
    Compaction as c,
    ToolCall+ as steps,
    ToolCall where name == "bash" and git_push_protected == true as push
) within 600s`;

const VPL_CONFIG_OVERWRITE_VIOLATION = `pattern ConfigOverwriteViolation = SEQ(
    Compaction as c,
    ToolCall+ as steps,
    ToolCall where touches_protected_path == true as write
) within 600s`;

const ALL_VPL_PATTERNS = [
  VPL_INTENT_STALL,
  VPL_COMPACTION_SPIRAL,
  VPL_CONTEXT_STARVATION,
  VPL_GIT_PUSH_VIOLATION,
  VPL_CONFIG_OVERWRITE_VIOLATION,
].join("\n\n");

const DEFAULT_INTENT_PHRASES: RegExp[] = [
  /\b(?:let me|i'll|i will|i'm going to)\s+(?:write|create|read|edit|run|search|execute)\b/i,
];

const DEFAULT_PROTECTED_BRANCHES = ["main", "master", "production"];

const DEFAULT_PROTECTED_PATH_PATTERNS: RegExp[] = [
  /\/prod[^/]*\//,
  /\/prod[^/]*$/,
  /\/production\./,
  /\/\.env$/,
  /\/\.env\./,
];

export interface ClaudeCodeAdapterConfig {
  protectedBranches?: string[];
  protectedPathPatterns?: RegExp[];
  compactionDropThreshold?: number;
  intentPhrases?: RegExp[];
  /** Detection history for Learn tier cross-session tracking. */
  history?: DetectionHistory;
  /** Current session ID for Learn tier tracking. */
  sessionId?: string;
  /** Minimum distinct sessions before Learn tier fires. Default: 3. */
  learnThreshold?: number;
  /** Cross-session convergent failure tracker. */
  convergentTracker?: ConvergentFailureTracker;
  /** Regex patterns to extract failure targets from error output. */
  failureTargetPatterns?: RegExp[];
}

type DetectionCallback = (detection: Detection) => void;
type IntentStallCallback = (detection: Detection, stallCount: number) => void;
type CompactionSpiralCallback = (detection: Detection, compactionCount: number) => void;
type LearnCallback = (proposal: LearnProposal, newContent: string) => void;
type StaleGuardrailCallback = (proposal: StaleGuardrailProposal) => void;

/** Default regex patterns for extracting failure targets from error output. */
const DEFAULT_FAILURE_TARGET_PATTERNS: RegExp[] = [
  // pytest: FAILED tests/test_auth.py::test_login
  /FAIL(?:ED)?\s+([\w./:-]+(?:::[\w]+)?)/,
  // jest: FAIL src/__tests__/auth.test.ts
  /FAIL\s+([\w./_-]+\.(?:test|spec)\.\w+)/,
  // cargo test: test tests::test_auth ... FAILED
  /test\s+([\w:]+)\s+\.\.\.\s+FAILED/,
  // generic assertion: AssertionError in tests/test_auth.py
  /(?:Error|Exception|FAILED)\s+(?:in\s+)?([\w./:-]+\.(?:py|js|ts|rs|go|java)(?:::[\w]+)?)/,
  // File path with line number: /path/to/test.py:42
  /([\w./:-]+\.(?:py|js|ts|rs|go|java):\d+)/,
];

export class ClaudeCodeAdapter {
  private runtime: VarpulisAgentRuntime;
  private protectedBranches: string[];
  private protectedPathPatterns: RegExp[];
  private compactionDropThreshold: number;
  private intentPhrases: RegExp[];

  private stallCount = 0;
  private compactionCount = 0;
  private lastTokenCount: number | null = null;

  private history: DetectionHistory | null;
  private sessionId: string;
  private learnThreshold: number;
  private claudeMdContent: string | null = null;
  private convergentTracker: ConvergentFailureTracker | null;
  private failureTargetPatterns: RegExp[];

  private intentStallListeners: IntentStallCallback[] = [];
  private compactionSpiralListeners: CompactionSpiralCallback[] = [];
  private violationListeners: DetectionCallback[] = [];
  private learnListeners: LearnCallback[] = [];
  private staleGuardrailListeners: StaleGuardrailCallback[] = [];

  constructor(runtime: VarpulisAgentRuntime, config?: ClaudeCodeAdapterConfig) {
    this.runtime = runtime;
    this.protectedBranches = config?.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES;
    this.protectedPathPatterns = config?.protectedPathPatterns ?? DEFAULT_PROTECTED_PATH_PATTERNS;
    this.compactionDropThreshold = config?.compactionDropThreshold ?? 0.20;
    this.intentPhrases = config?.intentPhrases ?? DEFAULT_INTENT_PHRASES;
    this.history = config?.history ?? null;
    this.sessionId = config?.sessionId ?? crypto.randomUUID?.() ?? `sess_${Date.now()}`;
    this.learnThreshold = config?.learnThreshold ?? 3;
    this.convergentTracker = config?.convergentTracker ?? null;
    this.failureTargetPatterns = config?.failureTargetPatterns ?? DEFAULT_FAILURE_TARGET_PATTERNS;

    // Load all Claude Code VPL patterns into the CEP engine
    runtime.addPatternsFromVpl(ALL_VPL_PATTERNS);

    // Listen for detections from the CEP engine to fire callbacks
    runtime.onDetection((d) => this.handleDetection(d));
  }

  /**
   * Observe an LLM response event, enriching with intent-stall metadata.
   */
  observeLlmResponse(event: {
    timestamp: number;
    model: string;
    has_tool_use: boolean;
    text?: string;
  }): Detection[] {
    const intentWithoutAction =
      !event.has_tool_use && this.matchesIntentPhrase(event.text ?? "");

    if (intentWithoutAction) {
      this.stallCount++;
    } else {
      this.stallCount = 0;
    }

    const agentEvent: AgentEvent = {
      timestamp: event.timestamp,
      event_type: {
        type: "LlmResponse",
        model: event.model,
        has_tool_use: event.has_tool_use,
      },
      metadata: {
        intent_without_action: intentWithoutAction,
        stall_count: this.stallCount,
        ...(event.text !== undefined && { text_snippet: event.text.slice(0, 200) }),
      },
    };

    return this.runtime.observe(agentEvent);
  }

  /**
   * Observe a tool call event, enriching with violation metadata.
   */
  observeToolCall(event: {
    timestamp: number;
    name: string;
    params_hash: number;
    duration_ms?: number;
    rawInput?: unknown;
  }): Detection[] {
    const gitPushProtected = this.isGitPushToProtected(event.name, event.rawInput);
    const touchesProtectedPath = this.touchesProtectedPath(event.name, event.rawInput);

    const agentEvent: AgentEvent = {
      timestamp: event.timestamp,
      event_type: {
        type: "ToolCall",
        name: event.name,
        params_hash: event.params_hash,
        duration_ms: event.duration_ms,
      },
      metadata: {
        git_push_protected: gitPushProtected,
        touches_protected_path: touchesProtectedPath,
        ...(event.rawInput !== undefined && {
          raw_input_hash: hashParams(
            typeof event.rawInput === "object" && event.rawInput !== null
              ? (event.rawInput as Record<string, unknown>)
              : { _value: String(event.rawInput) },
          ),
        }),
      },
    };

    return this.runtime.observe(agentEvent);
  }

  /**
   * Observe a tool result event, enriching with failure target metadata
   * for convergent failure detection.
   *
   * Call this for PostToolUse events. On failure, extracts the failure target
   * from error output using configurable regex patterns.
   */
  observeToolResult(event: {
    timestamp: number;
    name: string;
    success: boolean;
    error?: string;
    rawResponse?: unknown;
  }): Detection[] {
    // Extract failure target from error output
    let failureTarget: string | undefined;
    if (!event.success && event.error) {
      failureTarget = this.extractFailureTarget(event.error);
    }

    const agentEvent: AgentEvent = {
      timestamp: event.timestamp,
      event_type: {
        type: "ToolResult",
        name: event.name,
        success: event.success,
        error: event.error,
      },
      metadata: {
        ...(failureTarget && { failure_target: failureTarget }),
        ...(event.error && { error_preview: event.error.slice(0, 500) }),
      },
    };

    return this.runtime.observe(agentEvent);
  }

  /**
   * Register a callback for stale guardrail proposals (convergent failure detection).
   *
   * When N independent sessions fail on the same target, the convergent tracker
   * generates a proposal. The caller decides whether to write it to disk.
   * Returns an unsubscribe function.
   */
  onStaleGuardrail(callback: StaleGuardrailCallback): () => void {
    this.staleGuardrailListeners.push(callback);
    return () => {
      const idx = this.staleGuardrailListeners.indexOf(callback);
      if (idx !== -1) this.staleGuardrailListeners.splice(idx, 1);
    };
  }

  /**
   * Observe a compaction event, enriching with spiral and starvation metadata.
   */
  observeCompaction(event: {
    timestamp: number;
    pre_tokens: number;
    post_tokens: number;
    system_context_tokens?: number;
  }): Detection[] {
    const freedRatio =
      event.pre_tokens > 0
        ? (event.pre_tokens - event.post_tokens) / event.pre_tokens
        : 0;

    const systemContextRatio =
      event.system_context_tokens !== undefined && event.post_tokens > 0
        ? event.system_context_tokens / event.post_tokens
        : 0;

    // Detect compaction spiral: token count dropping between consecutive events
    const isCompactionDrop =
      this.lastTokenCount !== null &&
      this.lastTokenCount > 0 &&
      event.post_tokens < this.lastTokenCount * (1 - this.compactionDropThreshold);

    if (isCompactionDrop) {
      this.compactionCount++;
    }
    this.lastTokenCount = event.post_tokens;

    // Emit as a Custom event so the CEP engine can match Compaction patterns
    const agentEvent: AgentEvent = {
      timestamp: event.timestamp,
      event_type: {
        type: "Custom",
        name: "Compaction",
      },
      metadata: {
        pre_tokens: event.pre_tokens,
        post_tokens: event.post_tokens,
        freed_ratio: freedRatio,
        system_context_ratio: systemContextRatio,
        compaction_drop: isCompactionDrop,
        compaction_count: this.compactionCount,
        ...(event.system_context_tokens !== undefined && {
          system_context_tokens: event.system_context_tokens,
        }),
      },
    };

    return this.runtime.observe(agentEvent);
  }

  /**
   * Register a callback for IntentStall detections.
   * Returns an unsubscribe function.
   */
  onIntentStall(callback: IntentStallCallback): () => void {
    this.intentStallListeners.push(callback);
    return () => {
      const idx = this.intentStallListeners.indexOf(callback);
      if (idx !== -1) this.intentStallListeners.splice(idx, 1);
    };
  }

  /**
   * Register a callback for CompactionSpiral detections.
   * Returns an unsubscribe function.
   */
  onCompactionSpiral(callback: CompactionSpiralCallback): () => void {
    this.compactionSpiralListeners.push(callback);
    return () => {
      const idx = this.compactionSpiralListeners.indexOf(callback);
      if (idx !== -1) this.compactionSpiralListeners.splice(idx, 1);
    };
  }

  /**
   * Register a callback for violation detections (GitPushViolation, ConfigOverwriteViolation).
   * Returns an unsubscribe function.
   */
  onViolation(callback: DetectionCallback): () => void {
    this.violationListeners.push(callback);
    return () => {
      const idx = this.violationListeners.indexOf(callback);
      if (idx !== -1) this.violationListeners.splice(idx, 1);
    };
  }

  /**
   * Register a callback for Learn tier proposals.
   *
   * When a pattern fires enough times across sessions (default: 3),
   * the Learn tier generates a CLAUDE.md rule and calls this callback
   * with the proposal and the new CLAUDE.md content.
   *
   * The caller decides whether to write the file (dry-run vs auto-apply).
   * Returns an unsubscribe function.
   */
  onLearn(callback: LearnCallback): () => void {
    this.learnListeners.push(callback);
    return () => {
      const idx = this.learnListeners.indexOf(callback);
      if (idx !== -1) this.learnListeners.splice(idx, 1);
    };
  }

  /**
   * Set the current CLAUDE.md content for Learn tier deduplication.
   * Call this when the session starts or after writing a learned rule.
   */
  setClaudeMdContent(content: string): void {
    this.claudeMdContent = content;
  }

  // --- Private helpers ---

  private handleDetection(detection: Detection): void {
    switch (detection.pattern_name) {
      case "IntentStall":
        for (const cb of this.intentStallListeners) {
          cb(detection, this.stallCount);
        }
        break;
      case "CompactionSpiral":
        for (const cb of this.compactionSpiralListeners) {
          cb(detection, this.compactionCount);
        }
        break;
      case "GitPushViolation":
      case "ConfigOverwriteViolation":
        for (const cb of this.violationListeners) {
          cb(detection);
        }
        break;
      case "targeted_failure":
        this.handleTargetedFailure(detection);
        break;
    }

    // Learn tier evaluation
    this.evaluateLearn(detection);
  }

  private handleTargetedFailure(detection: Detection): void {
    if (!this.convergentTracker || this.staleGuardrailListeners.length === 0) return;

    const target = detection.details.failure_target as string | undefined;
    if (!target) return;

    const errorSummary = detection.message;
    const proposal = this.convergentTracker.record(
      target,
      this.sessionId,
      errorSummary,
    );

    if (proposal) {
      for (const cb of this.staleGuardrailListeners) {
        cb(proposal);
      }
    }
  }

  private evaluateLearn(detection: Detection): void {
    if (!this.history || this.learnListeners.length === 0) return;

    const result = evaluate(
      detection,
      this.history,
      this.sessionId,
      this.claudeMdContent ?? "",
      { threshold: this.learnThreshold },
    );

    if (result) {
      this.claudeMdContent = result.newContent;
      for (const cb of this.learnListeners) {
        cb(result.proposal, result.newContent);
      }
    }
  }

  private matchesIntentPhrase(text: string): boolean {
    return this.intentPhrases.some((re) => re.test(text));
  }

  private isGitPushToProtected(toolName: string, rawInput: unknown): boolean {
    if (toolName.toLowerCase() !== "bash") return false;
    const command = extractCommand(rawInput);
    if (!command) return false;

    // Match "git push" followed by optional remote and a protected branch
    const gitPushMatch = command.match(/git\s+push\b/);
    if (!gitPushMatch) return false;

    return this.protectedBranches.some((branch) => {
      // Match: git push origin main, git push main, git push -f origin main, etc.
      const branchPattern = new RegExp(`\\bgit\\s+push\\b[^|;&]*\\b${escapeRegExp(branch)}\\b`);
      return branchPattern.test(command);
    });
  }

  private extractFailureTarget(errorText: string): string | undefined {
    for (const re of this.failureTargetPatterns) {
      const match = errorText.match(re);
      if (match?.[1]) {
        return match[1];
      }
    }
    return undefined;
  }

  private touchesProtectedPath(toolName: string, rawInput: unknown): boolean {
    const lowerName = toolName.toLowerCase();
    if (lowerName !== "write" && lowerName !== "edit") return false;

    const filePath = extractFilePath(rawInput);
    if (!filePath) return false;

    return this.protectedPathPatterns.some((re) => re.test(filePath));
  }
}

function extractCommand(rawInput: unknown): string | null {
  if (typeof rawInput === "string") return rawInput;
  if (typeof rawInput === "object" && rawInput !== null) {
    const obj = rawInput as Record<string, unknown>;
    if (typeof obj.command === "string") return obj.command;
    if (typeof obj.cmd === "string") return obj.cmd;
  }
  return null;
}

function extractFilePath(rawInput: unknown): string | null {
  if (typeof rawInput === "string") return rawInput;
  if (typeof rawInput === "object" && rawInput !== null) {
    const obj = rawInput as Record<string, unknown>;
    if (typeof obj.file_path === "string") return obj.file_path;
    if (typeof obj.path === "string") return obj.path;
    if (typeof obj.filePath === "string") return obj.filePath;
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
