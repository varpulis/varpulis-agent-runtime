import { describe, it, expect } from "vitest";
import { proposeCommand, isCommandDuplicate } from "../learn/commands.js";
import type { Detection } from "../types.js";

function makeDetection(pattern: string): Detection {
  return {
    pattern_name: pattern,
    severity: "warning",
    action: "alert",
    message: `${pattern} detected`,
    details: {},
    timestamp: Date.now(),
  };
}

describe("proposeCommand", () => {
  it("generates research command for circular_reasoning", () => {
    const cmd = proposeCommand(makeDetection("circular_reasoning"));
    expect(cmd).not.toBeNull();
    expect(cmd!.name).toBe("research");
    expect(cmd!.content).toContain("Search once");
    expect(cmd!.content).toContain("Maximum 3 search rounds");
    expect(cmd!.file_path).toBe(".claude/commands/research.md");
  });

  it("generates unstick command for stuck_agent", () => {
    const cmd = proposeCommand(makeDetection("stuck_agent"));
    expect(cmd).not.toBeNull();
    expect(cmd!.name).toBe("unstick");
    expect(cmd!.content).toContain("alternative approaches");
  });

  it("generates debug command for error_spiral", () => {
    const cmd = proposeCommand(makeDetection("error_spiral"));
    expect(cmd).not.toBeNull();
    expect(cmd!.name).toBe("debug");
    expect(cmd!.content).toContain("root cause");
  });

  it("generates execute command for IntentStall", () => {
    const cmd = proposeCommand(makeDetection("IntentStall"));
    expect(cmd).not.toBeNull();
    expect(cmd!.name).toBe("execute");
    expect(cmd!.content).toContain("tool_use");
  });

  it("returns null for unknown pattern", () => {
    expect(proposeCommand(makeDetection("budget_runaway"))).toBeNull();
  });
});

describe("isCommandDuplicate", () => {
  it("detects duplicate by name", () => {
    const cmd = proposeCommand(makeDetection("circular_reasoning"))!;
    expect(isCommandDuplicate(cmd, ["research"])).toBe(true);
  });

  it("detects duplicate by name.md", () => {
    const cmd = proposeCommand(makeDetection("circular_reasoning"))!;
    expect(isCommandDuplicate(cmd, ["research.md"])).toBe(true);
  });

  it("detects duplicate by file path", () => {
    const cmd = proposeCommand(makeDetection("circular_reasoning"))!;
    expect(isCommandDuplicate(cmd, [".claude/commands/research.md"])).toBe(
      true,
    );
  });

  it("returns false for no match", () => {
    const cmd = proposeCommand(makeDetection("circular_reasoning"))!;
    expect(isCommandDuplicate(cmd, ["deploy", "test"])).toBe(false);
  });
});
