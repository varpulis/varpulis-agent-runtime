import type { WasmAgentRuntime } from "../wasm/varpulis_agent_wasm.js";
import type { AgentEvent, Detection, PatternConfig, RuntimeConfig } from "./types.js";

type DetectionCallback = (detection: Detection) => void;

/**
 * Real-time behavioral pattern detection for AI agents.
 *
 * Push agent events via `observe()` and receive detections when
 * problematic patterns (retry storms, stuck agents, etc.) are detected.
 */
export class VarpulisAgentRuntime {
  private wasm: WasmAgentRuntime;
  private listeners: DetectionCallback[] = [];

  constructor(wasm: WasmAgentRuntime, config?: RuntimeConfig) {
    this.wasm = wasm;

    if (config?.cooldown_ms !== undefined) {
      this.wasm.setCooldownMs(BigInt(config.cooldown_ms));
    }

    const patterns = config?.patterns;
    if (patterns) {
      for (const p of patterns) {
        switch (p.type) {
          case "retry_storm":
            this.wasm.addRetryStorm(JSON.stringify(p.config));
            break;
          case "stuck_agent":
            this.wasm.addStuckAgent(JSON.stringify(p.config));
            break;
          case "error_spiral":
            this.wasm.addErrorSpiral(JSON.stringify(p.config));
            break;
          case "budget_runaway":
            this.wasm.addBudgetRunaway(JSON.stringify(p.config));
            break;
          case "token_velocity":
            this.wasm.addTokenVelocity(JSON.stringify(p.config));
            break;
          case "circular_reasoning":
            this.wasm.addCircularReasoning(JSON.stringify(p.config));
            break;
        }
      }
    }
  }

  /**
   * Push an agent event through all detectors.
   * Returns any detections that fired.
   */
  observe(event: AgentEvent): Detection[] {
    const json = JSON.stringify(event);
    const resultJson = this.wasm.observe(json);
    const detections: Detection[] = JSON.parse(resultJson);

    for (const d of detections) {
      for (const listener of this.listeners) {
        listener(d);
      }
    }

    return detections;
  }

  /**
   * Register a callback for detections. Returns an unsubscribe function.
   */
  onDetection(callback: DetectionCallback): () => void {
    this.listeners.push(callback);
    return () => {
      const idx = this.listeners.indexOf(callback);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }

  /**
   * Convenience: register a callback for a specific pattern name.
   */
  on(patternName: string, callback: DetectionCallback): () => void {
    return this.onDetection((d) => {
      if (d.pattern_name === patternName) callback(d);
    });
  }

  /**
   * Add custom patterns from VPL source.
   * Each `pattern` declaration becomes a detector.
   *
   * @example
   * runtime.addPatternsFromVpl(`
   *   pattern GoalDrift = SEQ(
   *     ToolCall as first,
   *     ToolCall+ where name != first.name as drift
   *   ) within 60s
   * `);
   */
  addPatternsFromVpl(vplSource: string): number {
    return this.wasm.addPatternsFromVpl(vplSource);
  }

  /** Reset all detector state and cooldowns. */
  reset(): void {
    this.wasm.reset();
  }

  /** Number of events processed. */
  get eventCount(): number {
    return Number(this.wasm.eventCount());
  }
}
