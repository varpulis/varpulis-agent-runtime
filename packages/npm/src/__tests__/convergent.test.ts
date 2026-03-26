import { describe, it, expect } from "vitest";
import { ConvergentFailureTracker } from "../convergent.js";

describe("ConvergentFailureTracker", () => {
  it("does not emit proposal below session threshold", () => {
    const tracker = new ConvergentFailureTracker({ sessionThreshold: 3 });

    const r1 = tracker.record("test_auth.py::test_login", "session-1", "AssertionError");
    expect(r1).toBeNull();

    const r2 = tracker.record("test_auth.py::test_login", "session-2", "AssertionError");
    expect(r2).toBeNull();
  });

  it("emits proposal when session threshold is met", () => {
    const tracker = new ConvergentFailureTracker({ sessionThreshold: 3 });

    tracker.record("test_auth.py::test_login", "session-1", "AssertionError", "Add OAuth2");
    tracker.record("test_auth.py::test_login", "session-2", "AssertionError", "Refactor auth");
    const proposal = tracker.record("test_auth.py::test_login", "session-3", "AssertionError", "Fix login");

    expect(proposal).not.toBeNull();
    expect(proposal!.type).toBe("stale_guardrail");
    expect(proposal!.target).toBe("test_auth.py::test_login");
    expect(proposal!.session_count).toBe(3);
    expect(proposal!.status).toBe("pending");
    expect(proposal!.evidence).toHaveLength(3);
    expect(proposal!.recommendation).toContain("test_auth.py::test_login");
    expect(proposal!.recommendation).toContain("3 independent sessions");
  });

  it("does not duplicate proposals for the same target", () => {
    const tracker = new ConvergentFailureTracker({ sessionThreshold: 2 });

    tracker.record("test_a", "s1", "err");
    const p1 = tracker.record("test_a", "s2", "err");
    expect(p1).not.toBeNull();

    // Fourth session on same target — should not re-emit
    const p2 = tracker.record("test_a", "s3", "err");
    expect(p2).toBeNull();
  });

  it("does not count same session twice", () => {
    const tracker = new ConvergentFailureTracker({ sessionThreshold: 3 });

    tracker.record("test_b", "s1", "err");
    tracker.record("test_b", "s1", "err again"); // same session
    tracker.record("test_b", "s2", "err");
    const result = tracker.record("test_b", "s1", "err yet again"); // still only 2 distinct sessions
    expect(result).toBeNull();
  });

  it("tracks different targets independently", () => {
    const tracker = new ConvergentFailureTracker({ sessionThreshold: 2 });

    tracker.record("target_a", "s1", "err");
    tracker.record("target_b", "s1", "err");
    tracker.record("target_a", "s2", "err");

    // Only target_a should have a proposal
    const pending = tracker.getPendingTargets();
    expect(pending).toHaveLength(1);
    expect(pending[0].target).toBe("target_a");
  });

  it("serializes and deserializes state", () => {
    const tracker = new ConvergentFailureTracker({ sessionThreshold: 3 });

    tracker.record("test_x", "s1", "err");
    tracker.record("test_x", "s2", "err");

    const serialized = tracker.toJSON();
    const restored = ConvergentFailureTracker.fromJSON(serialized, { sessionThreshold: 3 });

    // Third session should trigger proposal on restored tracker
    const proposal = restored.record("test_x", "s3", "err");
    expect(proposal).not.toBeNull();
    expect(proposal!.target).toBe("test_x");
  });

  it("includes task descriptions in proposal when provided", () => {
    const tracker = new ConvergentFailureTracker({ sessionThreshold: 2 });

    tracker.record("test_z", "s1", "err", "Add feature X");
    const proposal = tracker.record("test_z", "s2", "err", "Refactor module Y");

    expect(proposal).not.toBeNull();
    expect(proposal!.recommendation).toContain("Add feature X");
    expect(proposal!.recommendation).toContain("Refactor module Y");
  });

  it("returns all records for dashboard display", () => {
    const tracker = new ConvergentFailureTracker({ sessionThreshold: 5 });

    tracker.record("target_1", "s1", "err");
    tracker.record("target_2", "s1", "err");
    tracker.record("target_2", "s2", "err");

    const records = tracker.getAllRecords();
    expect(records).toHaveLength(2);
  });
});
