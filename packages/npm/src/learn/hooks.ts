/**
 * Learn tier: Claude Code hook generation.
 *
 * Generates PreToolUse/PostToolUse guard scripts and settings.json
 * hook configurations from recurring detections.
 *
 * Guard scripts are simple stdin→stdout JSON processors that block
 * or warn on specific tool inputs. They are designed to be auditable
 * and safe — no side effects, no network calls.
 */

import type { Detection } from "../types.js";

/** A proposed Claude Code hook. */
export interface HookProposal {
  /** Pattern that triggered this proposal. */
  pattern_name: string;
  /** Hook event type. */
  type: "PreToolUse" | "PostToolUse";
  /** Tool name to match (e.g. "Bash", "Write"). */
  matcher: string;
  /** Action: block prevents the tool call, warn adds context. */
  action: "block" | "warn";
  /** Message shown to the agent when the hook fires. */
  message: string;
  /** Shell script content for the guard. */
  script: string;
  /** Suggested file path for the guard script (relative to project root). */
  script_path: string;
  /** Stable key for deduplication. */
  dedup_key: string;
}

/** Settings.json hook entry format. */
export interface HookConfig {
  matcher: string;
  hooks: Array<{
    type: "command";
    command: string;
  }>;
}

// ---------------------------------------------------------------------------
// Hook templates
// ---------------------------------------------------------------------------

type HookTemplate = (detection: Detection) => HookProposal | null;

const HOOK_TEMPLATES: Record<string, HookTemplate> = {
  GitPushViolation: (d) => {
    const branches = (d.details.branches as string[]) ?? [
      "main",
      "master",
      "production",
    ];
    const branchPattern = branches.join("|");
    return {
      pattern_name: "GitPushViolation",
      type: "PreToolUse",
      matcher: "Bash",
      action: "block",
      message: `Blocked: git push to protected branch (${branches.join(", ")}). Use a feature branch.`,
      script: guardScript({
        name: "git_push_guard",
        pattern: `GitPushViolation`,
        field: "command",
        regex: `git\\s+push\\b[^|;&]*(${branchPattern})\\b`,
        action: "deny",
        reason: `Blocked by Varpulis: git push to protected branch. Use a feature branch and create a PR.`,
      }),
      script_path: ".varpulis/guards/git_push_guard.sh",
      dedup_key: "hook_git_push_guard",
    };
  },

  ConfigOverwriteViolation: (d) => {
    const pathPatterns =
      (d.details.path_patterns as string[]) ?? [
        "\\.env$",
        "\\.env\\.",
        "prod",
        "production\\.",
      ];
    const regex = pathPatterns.join("|");
    return {
      pattern_name: "ConfigOverwriteViolation",
      type: "PreToolUse",
      matcher: "Write",
      action: "block",
      message:
        "Blocked: writing to production config requires explicit user approval.",
      script: guardScript({
        name: "config_write_guard",
        pattern: "ConfigOverwriteViolation",
        field: "file_path",
        regex,
        action: "deny",
        reason:
          "Blocked by Varpulis: writing to production config. Get explicit user approval first.",
      }),
      script_path: ".varpulis/guards/config_write_guard.sh",
      dedup_key: "hook_config_write_guard",
    };
  },

  retry_storm: (d) => {
    const toolName = (d.details.tool_name as string) ?? null;
    if (!toolName) return null;
    return {
      pattern_name: "retry_storm",
      type: "PreToolUse",
      matcher: toolName,
      action: "warn",
      message: `Warning: ${toolName} has been called repeatedly with identical parameters.`,
      script: guardScript({
        name: `retry_guard_${toolName.toLowerCase()}`,
        pattern: "retry_storm",
        field: "_raw",
        regex: ".", // matches anything — the guard uses a call counter
        action: "warn",
        reason: `Varpulis: ${toolName} was called repeatedly with identical parameters. Try a different approach.`,
        stateful: true,
        toolName,
      }),
      script_path: `.varpulis/guards/retry_guard_${toolName.toLowerCase()}.sh`,
      dedup_key: `hook_retry_guard_${toolName.toLowerCase()}`,
    };
  },

  CompactionSpiral: () => ({
    pattern_name: "CompactionSpiral",
    type: "PostToolUse",
    matcher: "Write",
    action: "warn",
    message: "Warning: CLAUDE.md is large. Large CLAUDE.md contributes to compaction spirals.",
    script: guardScript({
      name: "claudemd_size_guard",
      pattern: "CompactionSpiral",
      field: "file_path",
      regex: "CLAUDE\\.md$",
      action: "warn",
      reason:
        "Varpulis: CLAUDE.md was modified. Keep it concise to avoid compaction spirals.",
    }),
    script_path: ".varpulis/guards/claudemd_size_guard.sh",
    dedup_key: "hook_claudemd_size_guard",
  }),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a hook proposal from a detection.
 * Returns null if no hook template exists for this pattern.
 */
export function proposeHook(detection: Detection): HookProposal | null {
  const template = HOOK_TEMPLATES[detection.pattern_name];
  if (!template) return null;
  return template(detection);
}

/**
 * Merge a hook proposal into a settings.json hooks structure.
 * Returns the updated hooks object. Does not overwrite existing hooks
 * for the same matcher — appends alongside them.
 */
export function mergeHookConfig(
  proposal: HookProposal,
  existingHooks: Record<string, HookConfig[]> = {},
): Record<string, HookConfig[]> {
  const hooks = structuredClone(existingHooks);
  const eventType = proposal.type;

  if (!hooks[eventType]) {
    hooks[eventType] = [];
  }

  // Check if a guard with the same dedup_key already exists
  const markerComment = `# varpulis:${proposal.dedup_key}`;
  const alreadyExists = hooks[eventType].some((h) =>
    h.hooks.some((entry) => entry.command.includes(markerComment)),
  );
  if (alreadyExists) return hooks;

  // Find existing entry for this matcher or create new one
  let matcherEntry = hooks[eventType].find(
    (h) => h.matcher === proposal.matcher,
  );
  if (!matcherEntry) {
    matcherEntry = { matcher: proposal.matcher, hooks: [] };
    hooks[eventType].push(matcherEntry);
  }

  matcherEntry.hooks.push({
    type: "command",
    command: `${proposal.script_path} ${markerComment}`,
  });

  return hooks;
}

// ---------------------------------------------------------------------------
// Guard script generator
// ---------------------------------------------------------------------------

interface GuardScriptOptions {
  name: string;
  pattern: string;
  field: string;
  regex: string;
  action: "deny" | "warn";
  reason: string;
  stateful?: boolean;
  toolName?: string;
}

function guardScript(opts: GuardScriptOptions): string {
  const header = [
    "#!/usr/bin/env bash",
    `# Varpulis guard: ${opts.name}`,
    `# Generated by Learn tier from ${opts.pattern} pattern`,
    `# Action: ${opts.action}`,
    "",
    'input=$(cat)',
  ];

  if (opts.stateful && opts.toolName) {
    // Stateful retry guard: tracks consecutive identical calls via temp file
    return [
      ...header,
      "",
      `COUNTER_FILE="/tmp/varpulis_retry_\${USER}_${opts.toolName.toLowerCase()}"`,
      `params_hash=$(echo "$input" | jq -r '.tool_input | to_entries | sort_by(.key) | tostring' 2>/dev/null | md5sum | cut -d' ' -f1)`,
      "",
      `if [ -f "$COUNTER_FILE" ]; then`,
      `  prev_hash=$(head -1 "$COUNTER_FILE")`,
      `  count=$(tail -1 "$COUNTER_FILE")`,
      `  if [ "$params_hash" = "$prev_hash" ]; then`,
      `    count=$((count + 1))`,
      `  else`,
      `    count=1`,
      `  fi`,
      `else`,
      `  count=1`,
      `fi`,
      `echo "$params_hash" > "$COUNTER_FILE"`,
      `echo "$count" >> "$COUNTER_FILE"`,
      "",
      `if [ "$count" -ge 3 ]; then`,
      `  cat <<'HOOK_JSON'`,
      JSON.stringify(hookResponse(opts.action, opts.reason), null, 2),
      `HOOK_JSON`,
      `fi`,
    ].join("\n");
  }

  // Stateless guard: simple regex match
  const fieldExtract =
    opts.field === "_raw"
      ? 'value="$input"'
      : `value=$(echo "$input" | jq -r '.tool_input.${opts.field} // ""')`;

  return [
    ...header,
    fieldExtract,
    "",
    `if echo "$value" | grep -qE '${opts.regex}'; then`,
    `  cat <<'HOOK_JSON'`,
    JSON.stringify(hookResponse(opts.action, opts.reason), null, 2),
    `HOOK_JSON`,
    `fi`,
  ].join("\n");
}

function hookResponse(
  action: "deny" | "warn",
  reason: string,
): Record<string, unknown> {
  if (action === "deny") {
    return {
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    };
  }
  return {
    hookSpecificOutput: {
      additionalContext: reason,
    },
  };
}
