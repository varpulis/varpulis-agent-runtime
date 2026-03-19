/**
 * Standalone Node.js example — installs @varpulis/agent-runtime from the package
 * and demonstrates WASM loading + pattern detection end-to-end.
 *
 * Run:
 *   npm run setup   # install from local tarball
 *   npm start       # run this example
 */

import { WasmAgentRuntime } from '@varpulis/agent-runtime/wasm';
import { VarpulisAgentRuntime, Patterns, hashParams } from '@varpulis/agent-runtime';

// --- Setup runtime ---
const wasm = new WasmAgentRuntime();
const runtime = new VarpulisAgentRuntime(wasm, {
  patterns: [
    Patterns.retryStorm({ min_repetitions: 3, window_seconds: 10, kill_threshold: 5 }),
    Patterns.stuckAgent({ max_steps_without_output: 5 }),
    Patterns.budgetRunaway({ max_cost_usd: 0.10, max_tokens: 5000, window_seconds: 60 }),
    Patterns.errorSpiral({ min_error_count: 3 }),
    Patterns.circularReasoning(),
    Patterns.tokenVelocity({ baseline_window_steps: 3, spike_multiplier: 2.0 }),
  ],
  cooldown_ms: 0,
});

runtime.onDetection((d) => {
  const icon = d.action === 'kill' ? 'KILL' : d.severity.toUpperCase();
  console.log(`  [${icon}] ${d.pattern_name}: ${d.message}`);
});

// --- Scenario: Retry storm escalating to kill ---
console.log('\n=== Retry Storm (alert at 3, kill at 5) ===');
const ph = hashParams({ query: 'weather' });
for (let i = 0; i < 6; i++) {
  runtime.observe({
    timestamp: 1000000 + i * 1000,
    event_type: { type: 'ToolCall', name: 'search', params_hash: ph, duration_ms: 100 },
  });
}

runtime.reset();

// --- Scenario: Budget runaway ---
console.log('\n=== Budget Runaway ===');
for (let i = 0; i < 8; i++) {
  runtime.observe({
    timestamp: 2000000 + i * 2000,
    event_type: {
      type: 'LlmCall',
      model: 'test',
      input_tokens: 500,
      output_tokens: 300,
      cost_usd: 0.015,
    },
  });
}

runtime.reset();

// --- Scenario: Circular reasoning ---
console.log('\n=== Circular Reasoning ===');
const tools = ['search', 'read', 'search', 'read', 'search', 'read'];
for (let i = 0; i < tools.length; i++) {
  runtime.observe({
    timestamp: 3000000 + i * 1000,
    event_type: { type: 'ToolCall', name: tools[i], params_hash: i, duration_ms: 50 },
  });
}

console.log(`\nTotal events: ${runtime.eventCount}`);
console.log('Done! WASM loaded and all patterns working.');
