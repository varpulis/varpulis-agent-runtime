/**
 * Learn tier: CLAUDE.md rule generation, deduplication, and application.
 *
 * All functions are pure — no filesystem access. The caller provides
 * CLAUDE.md content as a string and receives the mutated string back.
 */

import type { Detection } from "../types.js";
import type { DetectionHistory } from "../history.js";

/** A proposed mutation to CLAUDE.md. */
export interface LearnProposal {
  /** Pattern that triggered this proposal. */
  pattern_name: string;
  /** The rule text to append. */
  rule_text: string;
  /** CLAUDE.md section heading to append under. */
  section: string;
  /** Rule severity prefix. */
  severity: "NEVER" | "ALWAYS" | "PREFER";
  /** Stable key for deduplication (normalized rule meaning). */
  dedup_key: string;
}

interface RuleContext {
  tool_name?: string;
  branch_name?: string;
  path_pattern?: string;
}

// ---------------------------------------------------------------------------
// Rule templates per pattern
// ---------------------------------------------------------------------------

type RuleTemplate = (ctx: RuleContext) => LearnProposal;

const RULE_TEMPLATES: Record<string, RuleTemplate> = {
  IntentStall: (ctx) => ({
    pattern_name: "IntentStall",
    rule_text:
      ctx.tool_name === "bash"
        ? "When a bash command is needed, emit the tool call immediately. Do not narrate the command before running it."
        : "ALWAYS call tools directly. NEVER describe what you will do before doing it — emit the tool_use block immediately.",
    section: "Behavioral Rules",
    severity: "ALWAYS",
    dedup_key: "intent_stall_no_narrate",
  }),

  CompactionSpiral: () => ({
    pattern_name: "CompactionSpiral",
    rule_text:
      "Keep CLAUDE.md concise (under 8KB). If context is tight, split the task into smaller sessions rather than relying on compaction.",
    section: "Behavioral Rules",
    severity: "PREFER",
    dedup_key: "compaction_spiral_context",
  }),

  ContextStarvation: () => ({
    pattern_name: "ContextStarvation",
    rule_text:
      "System context is consuming most of the context window. Reduce CLAUDE.md size or MCP server count.",
    section: "Behavioral Rules",
    severity: "PREFER",
    dedup_key: "context_starvation_reduce",
  }),

  retry_storm: (ctx) => ({
    pattern_name: "retry_storm",
    rule_text: ctx.tool_name
      ? `If ${ctx.tool_name} fails twice with the same parameters, stop retrying and report the error to the user.`
      : "If a tool call fails twice with identical parameters, stop retrying and report the error to the user.",
    section: "Behavioral Rules",
    severity: "ALWAYS",
    dedup_key: `retry_storm_${ctx.tool_name ?? "generic"}`,
  }),

  error_spiral: () => ({
    pattern_name: "error_spiral",
    rule_text:
      "When multiple tool calls fail in succession, stop and analyze the root cause before retrying. Do not attempt more than 3 failing calls without changing approach.",
    section: "Behavioral Rules",
    severity: "ALWAYS",
    dedup_key: "error_spiral_stop_analyze",
  }),

  circular_reasoning: () => ({
    pattern_name: "circular_reasoning",
    rule_text:
      "When searching for information: search once, read the top result, extract what you need, move on. Do not re-search the same query or alternate between the same tools without synthesizing.",
    section: "Behavioral Rules",
    severity: "ALWAYS",
    dedup_key: "circular_reasoning_search_once",
  }),

  stuck_agent: () => ({
    pattern_name: "stuck_agent",
    rule_text:
      "If you have taken more than 10 steps without producing output, stop and summarize your findings for the user.",
    section: "Behavioral Rules",
    severity: "ALWAYS",
    dedup_key: "stuck_agent_summarize",
  }),

  budget_runaway: () => ({
    pattern_name: "budget_runaway",
    rule_text:
      "Be concise in tool calls and avoid unnecessary LLM round-trips. Prefer batch operations over sequential ones.",
    section: "Behavioral Rules",
    severity: "PREFER",
    dedup_key: "budget_runaway_concise",
  }),

  GitPushViolation: (ctx) => ({
    pattern_name: "GitPushViolation",
    rule_text: ctx.branch_name
      ? `NEVER push directly to the ${ctx.branch_name} branch. Always use a feature branch and create a PR.`
      : "NEVER push directly to main, master, or production branches. Always use a feature branch and create a PR.",
    section: "Safety Rules",
    severity: "NEVER",
    dedup_key: `git_push_violation_${ctx.branch_name ?? "protected"}`,
  }),

  ConfigOverwriteViolation: (ctx) => ({
    pattern_name: "ConfigOverwriteViolation",
    rule_text: ctx.path_pattern
      ? `NEVER write to ${ctx.path_pattern} without explicit user approval.`
      : "NEVER write to production config files (.env, prod.*, production.*) without explicit user approval.",
    section: "Safety Rules",
    severity: "NEVER",
    dedup_key: `config_overwrite_${ctx.path_pattern ?? "prod_config"}`,
  }),

  targeted_failure: (ctx) => ({
    pattern_name: "targeted_failure",
    rule_text: ctx.tool_name
      ? `When ${ctx.tool_name} fails repeatedly on the same target, stop and report the failing target to the user instead of retrying.`
      : "When a tool fails repeatedly on the same target (test, file, or endpoint), stop and report the failing target to the user instead of retrying.",
    section: "Behavioral Rules",
    severity: "ALWAYS",
    dedup_key: `targeted_failure_${ctx.tool_name ?? "generic"}`,
  }),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a rule proposal from a detection.
 * Returns null if no rule template exists for this pattern.
 */
export function proposeRule(
  detection: Detection,
  context?: RuleContext,
): LearnProposal | null {
  const template = RULE_TEMPLATES[detection.pattern_name];
  if (!template) return null;

  const ctx: RuleContext = {
    tool_name:
      context?.tool_name ??
      (detection.details.tool_name as string | undefined),
    branch_name:
      context?.branch_name ??
      (detection.details.branch_name as string | undefined),
    path_pattern:
      context?.path_pattern ??
      (detection.details.path_pattern as string | undefined),
    ...context,
  };

  return template(ctx);
}

/**
 * Check if a proposed rule already exists in CLAUDE.md content.
 * Uses dedup_key matching and fuzzy text similarity.
 */
export function isDuplicate(
  proposal: LearnProposal,
  content: string,
): boolean {
  // Check for dedup_key marker (added by applyRule)
  if (content.includes(`<!-- varpulis:${proposal.dedup_key} -->`)) {
    return true;
  }

  // Fuzzy match: check if a significant portion of key words overlap
  const proposalWords = extractKeyWords(proposal.rule_text);
  const lines = content.split("\n");
  for (const line of lines) {
    const lineWords = extractKeyWords(line);
    if (lineWords.size < 3) continue;
    const overlap = intersection(proposalWords, lineWords);
    const similarity = overlap.size / Math.min(proposalWords.size, lineWords.size);
    if (similarity >= 0.6) return true;
  }

  return false;
}

/**
 * Apply a rule proposal to CLAUDE.md content.
 * If the rule already exists (duplicate), increments the reinforcement counter.
 * Returns the new content.
 */
export function applyRule(
  proposal: LearnProposal,
  content: string,
): string {
  // Check for existing dedup marker — reinforce instead of duplicate
  const marker = `<!-- varpulis:${proposal.dedup_key} -->`;
  const reinforceRe = new RegExp(
    `(${escapeRegExp(marker)})(?: ×(\\d+))?`,
  );
  const reinforceMatch = content.match(reinforceRe);
  if (reinforceMatch) {
    const count = parseInt(reinforceMatch[2] ?? "1", 10) + 1;
    return content.replace(reinforceRe, `${marker} ×${count}`);
  }

  // Build the rule line
  const ruleLine = `- ${proposal.rule_text} ${marker}`;

  // Find or create the section
  const sectionHeading = `## ${proposal.section}`;
  const sectionIdx = content.indexOf(sectionHeading);

  if (sectionIdx !== -1) {
    // Find the end of the section (next ## or end of file)
    const afterHeading = sectionIdx + sectionHeading.length;
    const nextSection = content.indexOf("\n## ", afterHeading);
    const insertAt = nextSection !== -1 ? nextSection : content.length;

    // Insert before next section, with blank line
    const before = content.slice(0, insertAt).trimEnd();
    const after = content.slice(insertAt);
    return `${before}\n${ruleLine}\n${after}`;
  }

  // Section doesn't exist — append at end
  const trimmed = content.trimEnd();
  return `${trimmed}\n\n${sectionHeading}\n\n${ruleLine}\n`;
}

/**
 * Full Learn lifecycle: check history, propose, check dedup, apply.
 *
 * Returns the proposal and new content if a rule should be applied,
 * or null if no action needed (pattern not repeated enough, already learned,
 * or rule already exists).
 */
export function evaluate(
  detection: Detection,
  history: DetectionHistory,
  sessionId: string,
  claudeMdContent: string,
  options?: {
    /** Minimum distinct sessions before learning. Default: 3. */
    threshold?: number;
    /** Context for rule template variable substitution. */
    context?: RuleContext;
    /** Safety-critical patterns bypass the session threshold. */
    forcedPatterns?: string[];
  },
): { proposal: LearnProposal; newContent: string } | null {
  const threshold = options?.threshold ?? 3;
  const forcedPatterns = options?.forcedPatterns ?? [
    "GitPushViolation",
    "ConfigOverwriteViolation",
  ];

  // Record the detection in history
  history.record(detection.pattern_name, sessionId);

  // Check if we should learn
  const forced = forcedPatterns.includes(detection.pattern_name);
  if (!forced && !history.shouldLearn(detection.pattern_name, threshold)) {
    return null;
  }

  // Generate proposal
  const proposal = proposeRule(detection, options?.context);
  if (!proposal) return null;

  // Check for duplicates
  if (isDuplicate(proposal, claudeMdContent)) {
    // Still mark as learned so we don't keep checking
    history.markLearned(detection.pattern_name);
    return null;
  }

  // Apply the rule
  const newContent = applyRule(proposal, claudeMdContent);
  history.markLearned(detection.pattern_name);

  return { proposal, newContent };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract meaningful words from text (lowercase, skip short/common words). */
function extractKeyWords(text: string): Set<string> {
  const stopWords = new Set([
    "the", "a", "an", "to", "do", "not", "and", "or", "if", "in",
    "of", "is", "it", "be", "as", "by", "on", "at", "for", "with",
    "you", "your", "this", "that", "from", "are", "was", "has", "have",
  ]);
  const words = text.toLowerCase().match(/[a-z]{3,}/g) ?? [];
  return new Set(words.filter((w) => !stopWords.has(w)));
}

function intersection<T>(a: Set<T>, b: Set<T>): Set<T> {
  const result = new Set<T>();
  for (const item of a) {
    if (b.has(item)) result.add(item);
  }
  return result;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
