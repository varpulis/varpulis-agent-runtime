export interface DetectionRecord {
  count: number;
  last_seen: string;
  sessions: string[];
  learn_applied: boolean;
}

/**
 * Tracks detection occurrences across sessions.
 * Use to decide when a recurring pattern should trigger the Learn tier.
 */
export class DetectionHistory {
  private records: Record<string, DetectionRecord>;

  constructor(initialData?: Record<string, DetectionRecord>) {
    this.records = initialData ? { ...initialData } : {};
  }

  /**
   * Record a detection occurrence from a session.
   * Returns the updated record.
   */
  record(patternName: string, sessionId: string): DetectionRecord {
    const existing = this.records[patternName];

    if (existing) {
      existing.count++;
      existing.last_seen = new Date().toISOString();
      if (!existing.sessions.includes(sessionId)) {
        existing.sessions.push(sessionId);
      }
      return existing;
    }

    const newRecord: DetectionRecord = {
      count: 1,
      last_seen: new Date().toISOString(),
      sessions: [sessionId],
      learn_applied: false,
    };
    this.records[patternName] = newRecord;
    return newRecord;
  }

  /**
   * Check if a pattern has been seen enough times to trigger the Learn tier.
   */
  shouldLearn(patternName: string, threshold = 3): boolean {
    const rec = this.records[patternName];
    if (!rec) return false;
    return rec.sessions.length >= threshold && !rec.learn_applied;
  }

  /**
   * Mark that the Learn tier was applied for a pattern.
   */
  markLearned(patternName: string): void {
    const rec = this.records[patternName];
    if (rec) {
      rec.learn_applied = true;
    }
  }

  /**
   * Export records for persistence.
   */
  toJSON(): Record<string, DetectionRecord> {
    return { ...this.records };
  }

  /**
   * Create a DetectionHistory from persisted data.
   */
  static fromJSON(data: Record<string, DetectionRecord>): DetectionHistory {
    return new DetectionHistory(data);
  }
}
