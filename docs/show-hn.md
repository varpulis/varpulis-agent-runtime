# Show HN: Varpulis – Real-time behavioral guardrails for AI agents

**URL:** https://github.com/varpulis/varpulis-agent-runtime

**Text:**

I built an open-source library that detects when AI agents go wrong — in real-time, not after the fact.

If you've deployed LangChain, MCP, or custom agents in production, you've probably seen these failure modes:

- **Retry storms:** Agent calls the same API with identical params 20 times because the LLM keeps regenerating the same tool call
- **Circular reasoning:** Agent alternates between search → read → search → read without making progress
- **Budget runaway:** Agent burns through $50 in API credits in a single run because nobody set a limit
- **Stuck agent:** 30 steps of "thinking" without ever producing an answer

The problem is these failures are invisible to existing tools. Each individual step looks fine — it's the *sequence over time* that reveals the problem. Observability tools (LangSmith, Braintrust) only show you traces after the damage is done. Static guardrails (NeMo, Guardrails AI) validate individual inputs/outputs but can't see temporal patterns.

**Varpulis Agent Runtime** detects these behavioral patterns as they unfold. It's a Rust library compiled to WASM (for JS/TS) and native extension via PyO3 (for Python). Runs in-process with <1ms latency per event. 220KB WASM bundle.

**6 pre-packaged patterns:** retry storm, stuck agent, error spiral, budget runaway, token velocity spike, circular reasoning. All configurable, with sensible defaults.

**Kill action:** When a pattern exceeds a configurable threshold, the runtime can suggest terminating the agent. The LangChain integration throws `VarpulisKillError` to stop execution.

Quick example (Python):

```python
from varpulis_agent_runtime import VarpulisAgentRuntime, Patterns

runtime = VarpulisAgentRuntime(patterns=[
    Patterns.retry_storm(min_repetitions=3, kill_threshold=5),
    Patterns.budget_runaway(max_cost_usd=0.50),
    Patterns.stuck_agent(max_steps_without_output=10),
])

@runtime.on("retry_storm")
def handle(detection):
    print(f"Detected: {detection['message']}")
```

Works with LangChain, MCP, OpenAI Agents SDK, or any custom agent via the raw `observe()` API.

The pattern detection engine uses regex-like event pattern matching with sliding time windows. Under the hood it's inspired by Complex Event Processing (CEP), but the API is just "push events, get detections" — no query language needed for the built-in patterns.

Built with Rust, wasm-bindgen, PyO3. 96 tests (54 Rust unit, 18 TS unit, 24 Playwright e2e running WASM in Chromium). Apache 2.0.

Would love feedback on which failure modes matter most to you and what patterns are missing.
