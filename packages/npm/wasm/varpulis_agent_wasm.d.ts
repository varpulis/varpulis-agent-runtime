/* tslint:disable */
/* eslint-disable */

/**
 * WASM-accessible wrapper around the Rust AgentRuntime.
 *
 * Events and detections are passed as JSON strings across the WASM boundary.
 */
export class WasmAgentRuntime {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Add a budget runaway detector (SASE Kleene+ with post-match aggregation).
     */
    addBudgetRunaway(config_json: string): void;
    /**
     * Add a circular reasoning detector (SASE sequence pattern).
     */
    addCircularReasoning(config_json: string): void;
    /**
     * Add an error spiral detector (SASE-backed with Kleene+).
     */
    addErrorSpiral(config_json: string): void;
    /**
     * Add a retry storm detector (SASE-backed with Kleene+).
     */
    addRetryStorm(config_json: string): void;
    /**
     * Add a stuck agent detector (SASE-backed with Kleene+).
     */
    addStuckAgent(config_json: string): void;
    /**
     * Add a token velocity spike detector.
     */
    addTokenVelocity(config_json: string): void;
    /**
     * Number of events processed.
     */
    eventCount(): bigint;
    /**
     * Create an empty runtime with no detectors.
     */
    constructor();
    /**
     * Push an event (as JSON) and return detections (as JSON array).
     */
    observe(event_json: string): string;
    /**
     * Reset all detector state and cooldowns.
     */
    reset(): void;
    /**
     * Set the cooldown period in milliseconds.
     */
    setCooldownMs(ms: bigint): void;
    /**
     * Create a runtime with all default patterns.
     */
    static withDefaultPatterns(): WasmAgentRuntime;
}
