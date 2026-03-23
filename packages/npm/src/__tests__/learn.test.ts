import { describe, it, expect } from "vitest";
import { proposeRule, isDuplicate, applyRule, evaluate } from "../learn/rules.js";
import { DetectionHistory } from "../history.js";
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

describe("proposeRule", () => {
  it("generates IntentStall rule", () => {
    const d = makeDetection("IntentStall");
    const proposal = proposeRule(d);
    expect(proposal).not.toBeNull();
    expect(proposal!.pattern_name).toBe("IntentStall");
    expect(proposal!.severity).toBe("ALWAYS");
    expect(proposal!.rule_text).toContain("tool");
  });

  it("generates bash-specific IntentStall rule", () => {
    const d = makeDetection("IntentStall", { tool_name: "bash" });
    const proposal = proposeRule(d);
    expect(proposal!.rule_text).toContain("bash");
  });

  it("generates retry_storm rule with tool name", () => {
    const d = makeDetection("retry_storm", { tool_name: "search" });
    const proposal = proposeRule(d);
    expect(proposal!.rule_text).toContain("search");
    expect(proposal!.dedup_key).toContain("search");
  });

  it("generates GitPushViolation rule", () => {
    const d = makeDetection("GitPushViolation");
    const proposal = proposeRule(d);
    expect(proposal!.severity).toBe("NEVER");
    expect(proposal!.section).toBe("Safety Rules");
  });

  it("returns null for unknown pattern", () => {
    const d = makeDetection("UnknownPattern");
    expect(proposeRule(d)).toBeNull();
  });
});

describe("isDuplicate", () => {
  it("detects dedup marker", () => {
    const proposal = proposeRule(makeDetection("IntentStall"))!;
    const content = `# CLAUDE.md\n\n- Some rule <!-- varpulis:${proposal.dedup_key} -->`;
    expect(isDuplicate(proposal, content)).toBe(true);
  });

  it("detects fuzzy match", () => {
    const proposal = proposeRule(makeDetection("IntentStall"))!;
    // Include enough key words from the rule to trigger 60% overlap
    const content = "- ALWAYS call tools directly, never describe what you will do before doing it.";
    expect(isDuplicate(proposal, content)).toBe(true);
  });

  it("returns false for unrelated content", () => {
    const proposal = proposeRule(makeDetection("IntentStall"))!;
    const content = "# My Project\n\nThis is a project about widgets.";
    expect(isDuplicate(proposal, content)).toBe(false);
  });
});

describe("applyRule", () => {
  it("creates section when it does not exist", () => {
    const proposal = proposeRule(makeDetection("IntentStall"))!;
    const result = applyRule(proposal, "# CLAUDE.md\n\nSome content.");
    expect(result).toContain("## Behavioral Rules");
    expect(result).toContain(proposal.rule_text);
    expect(result).toContain(`<!-- varpulis:${proposal.dedup_key} -->`);
  });

  it("appends to existing section", () => {
    const proposal = proposeRule(makeDetection("IntentStall"))!;
    const content = "# CLAUDE.md\n\n## Behavioral Rules\n\n- Existing rule.\n";
    const result = applyRule(proposal, content);
    expect(result).toContain("- Existing rule.");
    expect(result).toContain(proposal.rule_text);
    // Section heading should appear only once
    expect(result.match(/## Behavioral Rules/g)?.length).toBe(1);
  });

  it("inserts before next section", () => {
    const proposal = proposeRule(makeDetection("IntentStall"))!;
    const content = "## Behavioral Rules\n\n- Existing.\n\n## Other Section\n\nStuff.";
    const result = applyRule(proposal, content);
    const behavioralIdx = result.indexOf("## Behavioral Rules");
    const otherIdx = result.indexOf("## Other Section");
    const ruleIdx = result.indexOf(proposal.rule_text);
    // Rule should be between the two sections
    expect(ruleIdx).toBeGreaterThan(behavioralIdx);
    expect(ruleIdx).toBeLessThan(otherIdx);
  });

  it("reinforces existing rule instead of duplicating", () => {
    const proposal = proposeRule(makeDetection("IntentStall"))!;
    const marker = `<!-- varpulis:${proposal.dedup_key} -->`;
    const content = `## Behavioral Rules\n\n- ${proposal.rule_text} ${marker}\n`;
    const result = applyRule(proposal, content);
    expect(result).toContain(`${marker} ×2`);
    // Rule text should appear only once
    expect(result.match(new RegExp(proposal.dedup_key, "g"))?.length).toBe(1);
  });

  it("increments reinforcement counter", () => {
    const proposal = proposeRule(makeDetection("IntentStall"))!;
    const marker = `<!-- varpulis:${proposal.dedup_key} -->`;
    const content = `- Rule text ${marker} ×3\n`;
    const result = applyRule(proposal, content);
    expect(result).toContain(`${marker} ×4`);
  });
});

describe("evaluate", () => {
  it("returns null when threshold not met", () => {
    const history = new DetectionHistory();
    const detection = makeDetection("IntentStall");
    const result = evaluate(detection, history, "sess1", "");
    expect(result).toBeNull();
  });

  it("returns proposal after threshold met", () => {
    const history = new DetectionHistory();
    const detection = makeDetection("IntentStall");
    // Record in 3 distinct sessions
    history.record("IntentStall", "sess1");
    history.record("IntentStall", "sess2");
    // evaluate() internally calls record() for sess3
    const result = evaluate(detection, history, "sess3", "# CLAUDE.md");
    expect(result).not.toBeNull();
    expect(result!.proposal.pattern_name).toBe("IntentStall");
    expect(result!.newContent).toContain("## Behavioral Rules");
  });

  it("returns null when rule already exists (dedup)", () => {
    const history = new DetectionHistory();
    history.record("IntentStall", "sess1");
    history.record("IntentStall", "sess2");
    const detection = makeDetection("IntentStall");
    const marker = "<!-- varpulis:intent_stall_no_narrate -->";
    const result = evaluate(detection, history, "sess3", `Existing ${marker}`);
    expect(result).toBeNull();
  });

  it("forces learn for safety-critical patterns", () => {
    const history = new DetectionHistory();
    const detection = makeDetection("GitPushViolation");
    // Only 1 session — but GitPushViolation is forced
    const result = evaluate(detection, history, "sess1", "");
    expect(result).not.toBeNull();
    expect(result!.proposal.severity).toBe("NEVER");
    expect(result!.newContent).toContain("## Safety Rules");
  });

  it("marks pattern as learned", () => {
    const history = new DetectionHistory();
    history.record("IntentStall", "sess1");
    history.record("IntentStall", "sess2");
    const detection = makeDetection("IntentStall");
    evaluate(detection, history, "sess3", "");
    expect(history.shouldLearn("IntentStall")).toBe(false);
  });
});
