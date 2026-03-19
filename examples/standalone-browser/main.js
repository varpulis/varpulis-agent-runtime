import { WasmAgentRuntime } from '@varpulis/agent-runtime/wasm';
import { VarpulisAgentRuntime, Patterns, hashParams } from '@varpulis/agent-runtime';

const out = document.getElementById('output');
const lines = [];

function log(text, cls = '') {
  lines.push(cls ? `<span class="${cls}">${text}</span>` : text);
  out.innerHTML = lines.join('\n');
}

try {
  // Setup runtime with all patterns
  const wasm = new WasmAgentRuntime();
  const runtime = new VarpulisAgentRuntime(wasm, {
    patterns: [
      Patterns.retryStorm({ min_repetitions: 3, kill_threshold: 5 }),
      Patterns.stuckAgent({ max_steps_without_output: 5 }),
      Patterns.budgetRunaway({ max_cost_usd: 0.10 }),
      Patterns.errorSpiral({ min_error_count: 3 }),
      Patterns.circularReasoning(),
      Patterns.tokenVelocity({ baseline_window_steps: 3, spike_multiplier: 2.0 }),
    ],
    cooldown_ms: 0,
  });

  runtime.onDetection((d) => {
    const icon = d.action === 'kill' ? 'KILL' : d.severity.toUpperCase();
    log(`  [${icon}] ${d.pattern_name}: ${d.message}`, d.severity);
  });

  log('WASM loaded successfully!');
  log('');

  // Retry storm
  log('=== Retry Storm (alert at 3, kill at 5) ===');
  const ph = hashParams({ query: 'weather' });
  for (let i = 0; i < 6; i++) {
    runtime.observe({
      timestamp: 1000000 + i * 1000,
      event_type: { type: 'ToolCall', name: 'search', params_hash: ph, duration_ms: 100 },
    });
  }
  runtime.reset();
  log('');

  // Budget runaway
  log('=== Budget Runaway ===');
  for (let i = 0; i < 8; i++) {
    runtime.observe({
      timestamp: 2000000 + i * 2000,
      event_type: { type: 'LlmCall', model: 'test', input_tokens: 500, output_tokens: 300, cost_usd: 0.015 },
    });
  }
  runtime.reset();
  log('');

  // Circular reasoning
  log('=== Circular Reasoning ===');
  for (const [i, name] of ['search', 'read', 'search', 'read', 'search', 'read'].entries()) {
    runtime.observe({
      timestamp: 3000000 + i * 1000,
      event_type: { type: 'ToolCall', name, params_hash: i, duration_ms: 50 },
    });
  }
  log('');

  log(`Total events: ${runtime.eventCount}`);
  log('All patterns working in the browser!');

} catch (err) {
  log(`ERROR: ${err.message}`, 'error');
  console.error(err);
}
