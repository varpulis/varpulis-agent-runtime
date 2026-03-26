# Varpulis Agent Runtime

Real-time behavioral guardrails for AI agents.

Detect retry storms, circular reasoning, budget overruns, and failure spirals in your AI agents — as they happen, not after.

```bash
npm install @varpulis/agent-runtime
# or
pip install varpulis-agent-runtime
```

Works with **LangChain**, **CrewAI**, **MCP**, **OpenAI Agents SDK**, or any **OpenTelemetry**-instrumented agent.
Runs in-process via WASM (JS) or native extension (Python) — zero infrastructure, sub-millisecond latency.

**[Try the interactive playground](https://demo.varpulis-cep.com/agent-playground/)** — runs entirely in your browser via WebAssembly.

Powered by the **Varpulis CEP engine** — NFA-based pattern matching with Kleene closure and Zero-suppressed Decision Diagrams (ZDD) for efficient combinatorial matching.

---

## Why

AI agents in production fail in ways that are invisible to existing tools:

| Failure Mode | What Happens | Why Current Tools Miss It |
|---|---|---|
| **Retry storms** | Agent calls the same tool with identical params over and over | Each individual call looks valid |
| **Circular reasoning** | Agent alternates between tools without progressing (A→B→A→B→...) | Each step appears purposeful in isolation |
| **Budget runaway** | Cumulative LLM token spend exceeds threshold | No per-call anomaly, only aggregate |
| **Error spirals** | Tool error → reformulate → tool error → reformulate → ... | Each retry is different enough to pass static checks |
| **Stuck agent** | 20 steps of "thinking" without producing an answer | No single step is wrong |
| **Token velocity spike** | Sudden 3x increase in tokens per step | Gradual degradation, no sharp boundary |
| **Convergent failure** | 3 independent sessions fail on the same protected test | No single session sees the full picture |

These are **temporal patterns** — they only become visible when you look at sequences of events over time. Observability tools (LangSmith, Braintrust) analyze traces post-hoc. Static guardrails (Guardrails AI, NeMo) validate individual inputs/outputs. Varpulis detects behavioral patterns as they unfold.

---

## Quick Start

### One-Line Setup (Python)

```python
import varpulis_agent_runtime
varpulis_agent_runtime.init()
# That's it — LangChain, CrewAI, and OpenAI SDK are auto-patched.
# Your agent now has behavioral guardrails.
```

### JavaScript / TypeScript

```typescript
import { WasmAgentRuntime } from '@varpulis/agent-runtime/wasm/varpulis_agent_wasm.js';
import { VarpulisAgentRuntime, Patterns } from '@varpulis/agent-runtime';

// Create runtime with all default patterns
const wasm = WasmAgentRuntime.withDefaultPatterns();
const runtime = new VarpulisAgentRuntime(wasm);

// Or pick specific patterns with custom thresholds
const wasm2 = new WasmAgentRuntime();
const runtime2 = new VarpulisAgentRuntime(wasm2, {
  patterns: [
    Patterns.retryStorm({ min_repetitions: 3, window_seconds: 10 }),
    Patterns.budgetRunaway({ max_cost_usd: 0.50 }),
    Patterns.stuckAgent({ max_steps_without_output: 10 }),
  ],
  cooldown_ms: 5000,
});

// Listen for detections
runtime.on('retry_storm', (detection) => {
  console.warn(`Retry storm: ${detection.message}`);
});

runtime.on('budget_runaway', (detection) => {
  if (detection.severity === 'error') {
    console.error('Budget exceeded — killing agent');
    // your kill logic here
  }
});

// Push events from your agent's execution loop
runtime.observe({
  timestamp: Date.now(),
  event_type: {
    type: 'ToolCall',
    name: 'search_api',
    params_hash: hashParams({ query: 'weather in paris' }),
    duration_ms: 200,
  },
});
```

### Python

```python
from varpulis_agent_runtime import VarpulisAgentRuntime, Patterns

runtime = VarpulisAgentRuntime(
    patterns=[
        Patterns.retry_storm(min_repetitions=3, window_seconds=10),
        Patterns.budget_runaway(max_cost_usd=0.50),
        Patterns.stuck_agent(max_steps_without_output=10),
    ],
    cooldown_ms=5000,
)

@runtime.on("retry_storm")
def handle_retry_storm(detection):
    print(f"Retry storm: {detection['message']}")

# Push events
detections = runtime.observe(
    event_type={"type": "ToolCall", "name": "search", "params_hash": 42, "duration_ms": 200}
)
```

---

## Patterns

Seven pre-packaged patterns ship out of the box, plus cross-session convergent failure detection. All are configurable and have sensible defaults.

### Retry Storm

Same tool called N+ times with identical parameters within a time window.

```typescript
Patterns.retryStorm({
  min_repetitions: 3,   // default
  window_seconds: 10,   // default
})
```

**Detects:** Agent blindly retrying a failing API call, LLM regenerating the same tool call.

### Stuck Agent

Agent executes too many steps or spends too long without producing output.

```typescript
Patterns.stuckAgent({
  max_steps_without_output: 15,           // default
  max_time_without_output_seconds: 120,   // default
})
```

**Detects:** Agent stuck in a reasoning loop, infinite planning without action.

### Error Spiral

Repeated tool failures within a time window, regardless of which tool fails.

```typescript
Patterns.errorSpiral({
  min_error_count: 3,   // default
  window_seconds: 30,   // default
})
```

**Detects:** API outage causing cascade of failures, permission issues, network problems.

### Budget Runaway

Cumulative LLM cost or token usage exceeds thresholds. Fires a **warning at 80%** and an **error at 100%**.

```typescript
Patterns.budgetRunaway({
  max_cost_usd: 1.00,      // default
  max_tokens: 100_000,     // default
  window_seconds: 60,      // default
})
```

**Detects:** Agent burning through API credits, runaway token consumption.

### Token Velocity Spike

Sudden increase in token consumption rate per step compared to a rolling baseline.

```typescript
Patterns.tokenVelocity({
  baseline_window_steps: 5,   // default
  spike_multiplier: 2.0,      // default
})
```

**Detects:** Agent losing efficiency, generating increasingly verbose prompts.

### Circular Reasoning

Repeating cycle in tool call sequences (e.g., search→read→search→read→...).

```typescript
Patterns.circularReasoning({
  max_cycle_length: 4,         // default
  min_cycle_repetitions: 2,    // default
})
```

**Detects:** Agent stuck alternating between tools without making progress.

### Targeted Failure (Convergent Failure Detection)

Repeated failures on the same target (test, file, endpoint) within a session — the per-session building block for cross-session convergent failure detection.

```typescript
Patterns.targetedFailure({
  min_failures: 2,       // default
  window_seconds: 120,   // default
})
```

**Detects:** Agent hitting the same wall repeatedly. When combined with the `ConvergentFailureTracker` (see below), detects stale guardrails across independent sessions.

---

## Convergent Failure Detection

When multiple independent sessions — different users, different tasks, completely different code — all fail on the same target, the common denominator is the target, not the code.

This is the **cross-session correlation** layer. It answers the question: *"Is this protected test genuinely outdated, or is the agent doing something wrong?"*

### How it works

```
Session 1 ──ToolResult{fail}──▶ SASE Engine ──targeted_failure──┐
Session 2 ──ToolResult{fail}──▶ SASE Engine ──targeted_failure──┤
Session 3 ──ToolResult{fail}──▶ SASE Engine ──targeted_failure──┤
                                                                 ▼
                                               ConvergentFailureTracker
                                            (3 sessions × same target)
                                                         │
                                                         ▼
                                              StaleGuardrailProposal
                                          ┌──────────┴──────────┐
                                          ▼                     ▼
                                    .varpulis/proposals/   Dashboard UI
                                    (ring-fenced file)     (approve/dismiss)
```

1. **Per-session**: The `targeted_failure` SASE pattern detects repeated failures on the same target within a single session. The failure target is extracted from error output using regex (supports pytest, jest, cargo test, and generic patterns).

2. **Cross-session**: The `ConvergentFailureTracker` aggregates targeted failures across sessions. When N distinct sessions (default: 3) fail on the same target within a time window (default: 1 hour), it emits a `StaleGuardrailProposal`.

3. **Human review**: Proposals are written to `.varpulis/proposals/` as JSON files. A human reviews the evidence and decides whether to update the test or dismiss the concern.

**Agents propose amendments they can't ratify. Constitutional, not autocratic.**

### TypeScript

```typescript
import { ConvergentFailureTracker } from '@varpulis/agent-runtime';

const tracker = new ConvergentFailureTracker({
  sessionThreshold: 3,    // fire after 3 distinct sessions
  windowSeconds: 3600,    // within 1 hour
});

// When a targeted_failure detection fires in any session:
const proposal = tracker.record(
  'tests/test_auth.py::test_login',  // target
  'session-abc',                      // session ID
  'AssertionError: expected 200',     // error summary
  'Add OAuth2 support',               // what this session was doing
);

if (proposal) {
  // Write to .varpulis/proposals/ for human review
  console.log(proposal.recommendation);
  // "Target 'tests/test_auth.py::test_login' may be outdated — 3 independent
  //  sessions failed on it. Consider updating or removing this guardrail."
}

// Persist state between restarts
const state = tracker.toJSON();
const restored = ConvergentFailureTracker.fromJSON(state);
```

### Python

```python
from varpulis_agent_runtime import ConvergentFailureTracker

tracker = ConvergentFailureTracker(session_threshold=3, window_seconds=3600)

proposal = tracker.record(
    target="tests/test_auth.py::test_login",
    session_id="session-abc",
    error_summary="AssertionError: expected 200",
    task_description="Add OAuth2 support",
)

if proposal:
    print(proposal["recommendation"])

# Persist to disk
tracker.save(".varpulis/convergent_state.json")
restored = ConvergentFailureTracker.load(".varpulis/convergent_state.json")
```

### Claude Code Monitor

The [Claude Code Monitor](examples/claude-code-monitor/) integrates convergent failure detection out of the box. The monitor daemon:

- Tracks failure targets across all Claude Code sessions
- Extracts test names from error output automatically
- Writes proposals to `.varpulis/proposals/` when the threshold is met
- Displays proposals on the live dashboard with approve/dismiss buttons
- Exposes `GET /api/proposals` and `POST /api/proposals/<id>/resolve` endpoints

### Failure Target Extraction

The adapter automatically extracts failure targets from error output using these patterns:

| Framework | Example Error | Extracted Target |
|---|---|---|
| **pytest** | `FAILED tests/test_auth.py::test_login` | `tests/test_auth.py::test_login` |
| **jest** | `FAIL src/__tests__/auth.test.ts` | `src/__tests__/auth.test.ts` |
| **cargo test** | `test tests::test_auth ... FAILED` | `tests::test_auth` |
| **generic** | `Error in tests/test_auth.py:42` | `tests/test_auth.py:42` |

Custom patterns can be provided via the `failureTargetPatterns` config option.

---

## Framework Integrations

### LangChain (JS/TS)

```typescript
import { VarpulisLangChainHandler } from '@varpulis/agent-runtime';

const handler = new VarpulisLangChainHandler(runtime);

// Pass as a callback to any LangChain agent/chain
const result = await agent.invoke(
  { input: "What's the weather?" },
  { callbacks: [handler] }
);
```

### LangChain (Python)

```python
from varpulis_agent_runtime.integrations.langchain import VarpulisCallbackHandler

handler = VarpulisCallbackHandler(runtime)
result = agent.invoke({"input": "What's the weather?"}, config={"callbacks": [handler]})
```

### MCP (Model Context Protocol)

```typescript
import { McpAdapter } from '@varpulis/agent-runtime';

const adapter = new McpAdapter(runtime);

// In your MCP message handler:
server.on('tool_use', (msg) => {
  const detections = adapter.processToolUse({
    name: msg.name,
    arguments: msg.arguments,
  });
  // Handle detections...
});

server.on('tool_result', (msg) => {
  adapter.processToolResult({
    name: msg.name,
    content: msg.content,
    is_error: msg.is_error,
  });
});
```

### OpenAI Agents SDK

```typescript
import { createVarpulisOpenAIHooks } from '@varpulis/agent-runtime';

const hooks = createVarpulisOpenAIHooks(runtime);

// Wire into your agent's event loop
hooks.onToolStart('search_api', { query: 'weather' });
hooks.onToolEnd('search_api', 'sunny, 22°C');
hooks.onStepStart(1);
hooks.onStepEnd(1, true);
hooks.onLlmUsage(500, 200, 'gpt-4');
```

### CrewAI (Python)

```python
from varpulis_agent_runtime.integrations.crewai import VarpulisCrewAIHook

hook = VarpulisCrewAIHook(runtime)
hook.register()  # registers before/after tool hooks globally
# Returns False to block tool calls when kill-level patterns are detected
```

### OpenTelemetry (any OTel-instrumented framework)

```python
from varpulis_agent_runtime.integrations.opentelemetry import VarpulisSpanProcessor
from opentelemetry import trace

processor = VarpulisSpanProcessor(runtime)
trace.get_tracer_provider().add_span_processor(processor)
# Works with Phoenix, Pydantic AI, Vercel AI SDK, or any GenAI OTel spans
```

### Any Custom Agent

Use the raw `observe()` API to push events from any agent framework:

```typescript
runtime.observe({
  timestamp: Date.now(),
  event_type: { type: 'ToolCall', name: 'search', params_hash: 42, duration_ms: 200 },
});

runtime.observe({
  timestamp: Date.now(),
  event_type: { type: 'ToolResult', name: 'search', success: true },
});

runtime.observe({
  timestamp: Date.now(),
  event_type: { type: 'LlmCall', model: 'claude-sonnet-4-20250514', input_tokens: 500, output_tokens: 200, cost_usd: 0.003 },
});
```

---

## Event Types

Every agent action maps to one of these event types:

| Event Type | Fields | When to Emit |
|---|---|---|
| `ToolCall` | `name`, `params_hash`, `duration_ms` | Before/during a tool invocation |
| `ToolResult` | `name`, `success`, `error?` | After a tool returns (add `failure_target` in metadata for convergent failure tracking) |
| `LlmCall` | `model`, `input_tokens`, `output_tokens`, `cost_usd` | After an LLM call completes |
| `LlmResponse` | `model`, `has_tool_use` | After parsing the LLM response |
| `StepStart` | `step_number` | At the beginning of an agent step |
| `StepEnd` | `step_number`, `produced_output` | At the end of an agent step |
| `FinalAnswer` | `content_length` | When the agent produces a final output |

---

## Architecture

<p align="center">
  <img src="docs/architecture.svg" alt="Varpulis Agent Runtime Architecture" width="720">
</p>

The runtime is powered by the **Varpulis CEP engine** — an NFA-based pattern matching engine with Kleene closure support, compiled to WASM (JavaScript) or native extension via PyO3 (Python).

Each behavioral pattern is expressed as a sequence of event matchers with **Kleene closure** (`+` = one or more repetitions), **cross-event predicates** (e.g., "same tool name as the first call"), and **temporal windows**. The engine uses **Zero-suppressed Decision Diagrams (ZDD)** to efficiently handle combinatorial explosion — 20 events in a Kleene match produce ~1M combinations represented in ~100 ZDD nodes, not 1M explicit states.

Pattern detection runs in-process with sub-millisecond latency per event. 380KB WASM bundle.

### Patterns Under the Hood

Each pre-packaged pattern maps to a Kleene closure expression:

```
retry_storm:         same_tool_call{3+} within 10s
error_spiral:        tool_error{3+} within 30s
budget_runaway:      llm_call{+} within 60s where sum(cost) > threshold
stuck_agent:         step{no_output}{15+}     → reset on final_answer
circular_reasoning:  A → B → A → B           → cross-event name matching
token_velocity:      step-level token tracking with moving average baseline
targeted_failure:    tool_error{2+} within 120s → group by failure_target metadata
                     + cross-session ConvergentFailureTracker (N sessions × same target)
```

The `+` operator is **Kleene closure** — it matches one or more repetitions and the ZDD compactly represents all valid event combinations without exponential blowup.

### Custom VPL Patterns

Add your own patterns at runtime using VPL — no Rust code needed:

```python
runtime.add_patterns_from_vpl("""
    pattern GoalDrift = SEQ(
        ToolCall as first,
        ToolCall+ where name != first.name as drift
    ) within 60s
""")
```

```typescript
runtime.addPatternsFromVpl(`
    pattern TokenSpike = SEQ(
        LlmCall+ where output_tokens > 1000 as spike
    ) within 30s
`);
```

The built-in patterns ship as `.vpl` files in the [`patterns/`](patterns/) directory — readable, auditable, and forkable.

---

## API Reference

### `VarpulisAgentRuntime`

| Method | Description |
|---|---|
| `observe(event)` | Push an event, returns detections |
| `on(patternName, callback)` | Listen for a specific pattern |
| `onDetection(callback)` | Listen for all detections |
| `addPatternsFromVpl(source)` | Load custom VPL patterns |
| `reset()` | Clear all detector state |
| `eventCount` | Number of events processed |

### `Detection`

```typescript
{
  pattern_name: string;       // e.g. "retry_storm"
  severity: "info" | "warning" | "error" | "critical";
  action: "alert" | "kill";   // Suggested response
  message: string;            // Human-readable description
  details: Record<string, unknown>;  // Pattern-specific data
  timestamp: number;          // When the detection fired
}
```

### `ConvergentFailureTracker`

| Method | Description |
|---|---|
| `record(target, sessionId, errorSummary, taskDescription?)` | Record a failure. Returns a `StaleGuardrailProposal` if threshold met. |
| `getPendingTargets()` | Get all targets that have met the session threshold |
| `getAllRecords()` | Get all tracked records (for dashboard display) |
| `toJSON()` / `fromJSON(data)` | Serialize/deserialize state for persistence |
| `save(path)` / `load(path)` | Python only: persist to/from JSON file |

### `StaleGuardrailProposal`

```typescript
{
  type: "stale_guardrail";
  target: string;               // e.g. "tests/test_auth.py::test_login"
  evidence: SessionEvidence[];  // Which sessions failed and when
  session_count: number;        // Number of distinct sessions
  first_seen: string;           // ISO timestamp of first failure
  last_seen: string;            // ISO timestamp of most recent failure
  recommendation: string;       // Human-readable recommendation
  status: "pending" | "approved" | "dismissed";
  created_at: string;           // When the proposal was generated
}
```

---

## License

Apache-2.0
