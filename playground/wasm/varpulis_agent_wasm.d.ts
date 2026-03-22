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
     * Add patterns from VPL source. Returns the number of patterns added.
     * Requires the `vpl` feature on `varpulis-agent-core` (enabled by default).
     */
    addPatternsFromVpl(vpl_source: string): number;
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

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmagentruntime_free: (a: number, b: number) => void;
    readonly wasmagentruntime_addBudgetRunaway: (a: number, b: number, c: number) => [number, number];
    readonly wasmagentruntime_addCircularReasoning: (a: number, b: number, c: number) => [number, number];
    readonly wasmagentruntime_addErrorSpiral: (a: number, b: number, c: number) => [number, number];
    readonly wasmagentruntime_addPatternsFromVpl: (a: number, b: number, c: number) => [number, number, number];
    readonly wasmagentruntime_addRetryStorm: (a: number, b: number, c: number) => [number, number];
    readonly wasmagentruntime_addStuckAgent: (a: number, b: number, c: number) => [number, number];
    readonly wasmagentruntime_addTokenVelocity: (a: number, b: number, c: number) => [number, number];
    readonly wasmagentruntime_eventCount: (a: number) => bigint;
    readonly wasmagentruntime_new: () => number;
    readonly wasmagentruntime_observe: (a: number, b: number, c: number) => [number, number, number, number];
    readonly wasmagentruntime_reset: (a: number) => void;
    readonly wasmagentruntime_setCooldownMs: (a: number, b: bigint) => void;
    readonly wasmagentruntime_withDefaultPatterns: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
