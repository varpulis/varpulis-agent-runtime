import { describe, it, expect } from "vitest";
import { proposeHook, mergeHookConfig } from "../learn/hooks.js";
import type { Detection } from "../types.js";

function makeDetection(
  pattern: string,
  details: Record<string, unknown> = {},
): Detection {
  return {
    pattern_name: pattern,
    severity: "warning",
    action: "alert",
    message: `${pattern} detected`,
    details,
    timestamp: Date.now(),
  };
}

describe("proposeHook", () => {
  it("generates git push guard hook", () => {
    const d = makeDetection("GitPushViolation");
    const hook = proposeHook(d);
    expect(hook).not.toBeNull();
    expect(hook!.type).toBe("PreToolUse");
    expect(hook!.matcher).toBe("Bash");
    expect(hook!.action).toBe("block");
    expect(hook!.script).toContain("#!/usr/bin/env bash");
    expect(hook!.script).toContain("git_push_guard");
    expect(hook!.script).toContain("permissionDecision");
    expect(hook!.script).toContain("deny");
  });

  it("generates config overwrite guard hook", () => {
    const d = makeDetection("ConfigOverwriteViolation");
    const hook = proposeHook(d);
    expect(hook).not.toBeNull();
    expect(hook!.type).toBe("PreToolUse");
    expect(hook!.matcher).toBe("Write");
    expect(hook!.action).toBe("block");
    expect(hook!.script_path).toContain("config_write_guard");
  });

  it("generates retry storm guard with tool name", () => {
    const d = makeDetection("retry_storm", { tool_name: "search" });
    const hook = proposeHook(d);
    expect(hook).not.toBeNull();
    expect(hook!.matcher).toBe("search");
    expect(hook!.action).toBe("warn");
    expect(hook!.script).toContain("COUNTER_FILE");
    expect(hook!.script_path).toContain("search");
  });

  it("returns null for retry_storm without tool name", () => {
    const d = makeDetection("retry_storm");
    expect(proposeHook(d)).toBeNull();
  });

  it("generates compaction spiral PostToolUse hook", () => {
    const d = makeDetection("CompactionSpiral");
    const hook = proposeHook(d);
    expect(hook).not.toBeNull();
    expect(hook!.type).toBe("PostToolUse");
    expect(hook!.matcher).toBe("Write");
    expect(hook!.action).toBe("warn");
  });

  it("returns null for unknown pattern", () => {
    const d = makeDetection("UnknownPattern");
    expect(proposeHook(d)).toBeNull();
  });
});

describe("mergeHookConfig", () => {
  it("creates new hook config from empty", () => {
    const hook = proposeHook(makeDetection("GitPushViolation"))!;
    const result = mergeHookConfig(hook);
    expect(result.PreToolUse).toHaveLength(1);
    expect(result.PreToolUse[0].matcher).toBe("Bash");
    expect(result.PreToolUse[0].hooks).toHaveLength(1);
    expect(result.PreToolUse[0].hooks[0].command).toContain(hook.script_path);
  });

  it("appends to existing matcher", () => {
    const existing = {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command" as const, command: "existing.sh" }],
        },
      ],
    };
    const hook = proposeHook(makeDetection("GitPushViolation"))!;
    const result = mergeHookConfig(hook, existing);
    expect(result.PreToolUse).toHaveLength(1);
    expect(result.PreToolUse[0].hooks).toHaveLength(2);
  });

  it("deduplicates by dedup_key marker", () => {
    const hook = proposeHook(makeDetection("GitPushViolation"))!;
    const first = mergeHookConfig(hook);
    const second = mergeHookConfig(hook, first);
    // Should not add a second entry
    expect(second.PreToolUse[0].hooks).toHaveLength(1);
  });

  it("creates separate event types", () => {
    const preHook = proposeHook(makeDetection("GitPushViolation"))!;
    const postHook = proposeHook(makeDetection("CompactionSpiral"))!;
    let result = mergeHookConfig(preHook);
    result = mergeHookConfig(postHook, result);
    expect(result.PreToolUse).toHaveLength(1);
    expect(result.PostToolUse).toHaveLength(1);
  });
});
