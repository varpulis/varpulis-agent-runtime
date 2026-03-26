/**
 * Cross-session convergent failure tracking.
 *
 * Aggregates per-session targeted_failure detections by failure target.
 * When N distinct sessions fail on the same target within a time window,
 * emits a StaleGuardrailProposal for human review.
 */

export interface ConvergentFailureConfig {
  /** Minimum distinct sessions failing on the same target. Default: 3. */
  sessionThreshold: number;
  /** Time window in seconds for considering failures recent. Default: 3600 (1h). */
  windowSeconds: number;
  /** Directory path for proposal files. Default: ".varpulis/proposals". */
  proposalDir: string;
}

export interface SessionEvidence {
  session_id: string;
  timestamp: string;
  error_summary: string;
  task_description?: string;
}

export interface TargetFailureRecord {
  target: string;
  sessions: SessionEvidence[];
  first_seen: string;
  last_seen: string;
}

export interface StaleGuardrailProposal {
  type: "stale_guardrail";
  target: string;
  evidence: SessionEvidence[];
  session_count: number;
  first_seen: string;
  last_seen: string;
  recommendation: string;
  status: "pending" | "approved" | "dismissed";
  created_at: string;
}

const DEFAULT_CONFIG: ConvergentFailureConfig = {
  sessionThreshold: 3,
  windowSeconds: 3600,
  proposalDir: ".varpulis/proposals",
};

/**
 * Tracks failure targets across sessions to detect stale guardrails.
 *
 * Usage:
 * 1. When a per-session `targeted_failure` detection fires, call `record()`.
 * 2. If `record()` returns a `StaleGuardrailProposal`, write it to the proposals directory.
 * 3. Persist the tracker state between restarts via `toJSON()`/`fromJSON()`.
 */
export class ConvergentFailureTracker {
  private records: Map<string, TargetFailureRecord>;
  private config: ConvergentFailureConfig;
  private emittedTargets: Set<string>;

  constructor(config?: Partial<ConvergentFailureConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.records = new Map();
    this.emittedTargets = new Set();
  }

  /**
   * Record a per-session targeted failure detection.
   *
   * @param target - The failure target (test name, file path, endpoint).
   * @param sessionId - The session that experienced the failure.
   * @param errorSummary - Brief description of the error.
   * @param taskDescription - Optional description of what the session was trying to do.
   * @returns A StaleGuardrailProposal if the threshold is met, null otherwise.
   */
  record(
    target: string,
    sessionId: string,
    errorSummary: string,
    taskDescription?: string,
  ): StaleGuardrailProposal | null {
    const now = new Date().toISOString();

    // Get or create record for this target
    let rec = this.records.get(target);
    if (!rec) {
      rec = {
        target,
        sessions: [],
        first_seen: now,
        last_seen: now,
      };
      this.records.set(target, rec);
    }

    // Prune old evidence outside the window
    const cutoff = Date.now() - this.config.windowSeconds * 1000;
    rec.sessions = rec.sessions.filter(
      (s) => new Date(s.timestamp).getTime() >= cutoff,
    );

    // Add evidence if this session hasn't been recorded yet for this target
    const existingSession = rec.sessions.find((s) => s.session_id === sessionId);
    if (!existingSession) {
      rec.sessions.push({
        session_id: sessionId,
        timestamp: now,
        error_summary: errorSummary,
        ...(taskDescription && { task_description: taskDescription }),
      });
    }
    rec.last_seen = now;

    // Check if threshold met and not already emitted
    const distinctSessions = new Set(rec.sessions.map((s) => s.session_id)).size;
    if (
      distinctSessions >= this.config.sessionThreshold &&
      !this.emittedTargets.has(target)
    ) {
      this.emittedTargets.add(target);
      return this.buildProposal(rec);
    }

    return null;
  }

  /**
   * Get all pending proposals (targets that have met threshold).
   */
  getPendingTargets(): TargetFailureRecord[] {
    const results: TargetFailureRecord[] = [];
    for (const rec of this.records.values()) {
      const distinctSessions = new Set(rec.sessions.map((s) => s.session_id)).size;
      if (distinctSessions >= this.config.sessionThreshold) {
        results.push(rec);
      }
    }
    return results;
  }

  /**
   * Get all tracked records (for dashboard display).
   */
  getAllRecords(): TargetFailureRecord[] {
    return Array.from(this.records.values());
  }

  /**
   * Export for persistence.
   */
  toJSON(): {
    records: Record<string, TargetFailureRecord>;
    emitted: string[];
  } {
    const records: Record<string, TargetFailureRecord> = {};
    for (const [key, val] of this.records) {
      records[key] = val;
    }
    return {
      records,
      emitted: Array.from(this.emittedTargets),
    };
  }

  /**
   * Restore from persisted data.
   */
  static fromJSON(
    data: { records: Record<string, TargetFailureRecord>; emitted: string[] },
    config?: Partial<ConvergentFailureConfig>,
  ): ConvergentFailureTracker {
    const tracker = new ConvergentFailureTracker(config);
    for (const [key, val] of Object.entries(data.records)) {
      tracker.records.set(key, val);
    }
    for (const target of data.emitted) {
      tracker.emittedTargets.add(target);
    }
    return tracker;
  }

  private buildProposal(rec: TargetFailureRecord): StaleGuardrailProposal {
    const sessionCount = new Set(rec.sessions.map((s) => s.session_id)).size;
    const tasks = rec.sessions
      .map((s) => s.task_description)
      .filter(Boolean);
    const taskContext =
      tasks.length > 0
        ? ` with different tasks (${tasks.join(", ")})`
        : "";

    return {
      type: "stale_guardrail",
      target: rec.target,
      evidence: [...rec.sessions],
      session_count: sessionCount,
      first_seen: rec.first_seen,
      last_seen: rec.last_seen,
      recommendation:
        `Target '${rec.target}' may be outdated — ${sessionCount} independent sessions failed on it${taskContext}. ` +
        `Consider updating or removing this guardrail.`,
      status: "pending",
      created_at: new Date().toISOString(),
    };
  }
}
