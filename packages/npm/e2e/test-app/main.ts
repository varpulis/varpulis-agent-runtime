import { WasmAgentRuntime } from "../../wasm/varpulis_agent_wasm.js";
import { VarpulisAgentRuntime } from "../../src/runtime.js";
import { McpAdapter } from "../../src/mcp.js";
import { Patterns } from "../../src/patterns.js";
import { hashParams } from "../../src/hash.js";
import type { RuntimeConfig, Detection } from "../../src/types.js";

// Expose test harness on window for Playwright page.evaluate() access.
declare global {
  interface Window {
    VarpulisTestHarness: {
      createRuntime: (config?: RuntimeConfig) => VarpulisAgentRuntime;
      createMcpAdapter: (runtime: VarpulisAgentRuntime) => McpAdapter;
      Patterns: typeof Patterns;
      hashParams: typeof hashParams;
      WasmAgentRuntime: typeof WasmAgentRuntime;
      VarpulisAgentRuntime: typeof VarpulisAgentRuntime;
      ready: boolean;
    };
  }
}

try {
  window.VarpulisTestHarness = {
    createRuntime(config?: RuntimeConfig) {
      const wasm = config?.patterns
        ? new WasmAgentRuntime()
        : WasmAgentRuntime.withDefaultPatterns();
      return new VarpulisAgentRuntime(wasm, config);
    },
    createMcpAdapter(runtime: VarpulisAgentRuntime) {
      return new McpAdapter(runtime);
    },
    Patterns,
    hashParams,
    WasmAgentRuntime,
    VarpulisAgentRuntime,
    ready: true,
  };

  const status = document.getElementById("status")!;
  status.textContent = "Ready";
  status.className = "status ready";
  document.getElementById("log")!.textContent = "WASM loaded. Harness ready for tests.";
} catch (err) {
  const status = document.getElementById("status")!;
  status.textContent = "Error";
  status.className = "status error";
  document.getElementById("log")!.textContent = `Failed to initialize: ${err}`;
}
