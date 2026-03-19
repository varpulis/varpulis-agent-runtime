# Show HN: Varpulis – Real-time behavioral guardrails for AI agents

**URL:** https://github.com/varpulis/varpulis-agent-runtime

**Text:**

I built an open-source library that detects when AI agents go wrong — in real-time, not after the fact.

If you've deployed LangChain, MCP, or custom agents in production, you've probably seen these failure modes:

- **Retry storms:** Agent calls the same API with identical params 20 times because the LLM keeps regenerating the same tool call
- **Circular reasoning:** Agent alternates between search → read → search → read without making progress
- **Budget runaway:** Agent burns through $50 in API credits in a single run because nobody set a limit
- **Stuck agent:** 30 steps of "thinking" without ever producing an answer

The problem is these failures are invisible to existing tools. Each individual step looks fine — it's the *sequence over time* that reveals the problem. Observability tools show you traces after the damage is done. Static guardrails validate individual inputs/outputs but can't see temporal patterns.

Without something like this, the typical fix is a hardcoded `max_iterations=10` and a prayer.

**Varpulis Agent Runtime** detects these behavioral patterns as they unfold. It's built on an NFA-based pattern matching engine with Kleene closure support, compiled to WASM for JS/TS and native extension via PyO3 for Python. <1ms latency per event. 316KB WASM bundle.

Each pattern is a Kleene closure expression (`+` = one or more repetitions):

```
retry_storm:         same_tool_call{3+} within 10s
error_spiral:        tool_error{3+} within 30s
stuck_agent:         step{no_output}{15+}, reset on final_answer
circular_reasoning:  A → B → A → B (cross-event name matching)
budget_runaway:      llm_call{+} within 60s where sum(cost) > threshold
```

The Kleene closure is backed by Zero-suppressed Decision Diagrams (ZDD) to avoid exponential blowup — 20 events in a Kleene match produce ~1M combinations represented in ~100 ZDD nodes.

**6 pre-packaged patterns**, all configurable. **Kill action** when thresholds are exceeded. Works with LangChain, MCP, OpenAI Agents SDK, or any custom agent.

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

We tested it on itself — wired into Claude Code via HTTP hooks. The monitor feeds detections back into the agent's context as `additionalContext`, so the agent self-corrects when patterns are detected. During development it caught a real `Edit → Bash → Edit → Bash` circular pattern and injected "break the cycle by trying a different approach" into the agent's next turn. For kill-level detections, it blocks the tool call entirely via `permissionDecision: "deny"`.

Built with Rust, wasm-bindgen, PyO3. 103 tests (61 Rust unit, 18 TS unit, 24 Playwright e2e running WASM in Chromium). Apache 2.0.

Would love feedback on which failure modes matter most to you and what patterns are missing.
