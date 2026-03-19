/**
 * MCP Monitor Example
 *
 * Shows how to use the McpAdapter to monitor MCP tool calls
 * for behavioral patterns.
 */

// In a real project you'd import from '@varpulis/agent-runtime'
// Here we import from the source for demonstration
import { WasmAgentRuntime } from '../../packages/npm/wasm/varpulis_agent_wasm.js';
import { VarpulisAgentRuntime, Patterns, McpAdapter } from '../../packages/npm/src/index.js';

// Create runtime with patterns tuned for MCP monitoring
const wasm = new WasmAgentRuntime();
const runtime = new VarpulisAgentRuntime(wasm, {
  patterns: [
    Patterns.retryStorm({ min_repetitions: 3, window_seconds: 10 }),
    Patterns.errorSpiral({ min_error_count: 3, window_seconds: 30 }),
  ],
  cooldown_ms: 0,
});

// Listen for detections
runtime.onDetection((d) => {
  console.log(`  [${d.severity.toUpperCase()}] ${d.pattern_name}: ${d.message}`);
});

// Create MCP adapter
const adapter = new McpAdapter(runtime);

// --- Simulate MCP tool calls ---

console.log('\n=== MCP Agent: Searching for config file ===');
console.log('The agent keeps asking the MCP server for a file that does not exist.\n');

// Agent calls file_search 5 times with same params
for (let i = 0; i < 5; i++) {
  console.log(`> tool_use: file_search({ path: "/etc", pattern: "config.yaml" })`);
  adapter.processToolUse({
    name: 'file_search',
    arguments: { path: '/etc', pattern: 'config.yaml' },
    id: `call_${i}`,
  });

  console.log(`< tool_result: error "File not found"`);
  adapter.processToolResult({
    name: 'file_search',
    content: 'File not found: /etc/config.yaml',
    is_error: true,
  });

  console.log('');
}

console.log(`\nTotal events: ${runtime.eventCount}`);
