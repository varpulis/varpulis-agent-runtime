# How to Prevent Your AI Agent from Burning $50 in a Loop

If you've built AI agents with LangChain, MCP, or the OpenAI Agents SDK, you've probably had this experience: your agent works great 90% of the time. The other 10%, it goes haywire — retrying the same failing API call endlessly, stuck in a reasoning loop, or burning through API credits with increasingly verbose prompts.

The scary part? Each individual step looks perfectly reasonable. It's only when you look at the sequence over time that the problem becomes obvious.

## The Problem: Temporal Blindness

Current tools for AI agent reliability fall into two categories:

**Observability tools** (LangSmith, Braintrust, Langfuse) show you beautiful traces and dashboards — after the damage is done. By the time you see the trace of your agent calling the same API 47 times, you've already burned $50.

**Static guardrails** (Guardrails AI, NeMo Guardrails) validate individual inputs and outputs. They can catch PII in prompts or malformed JSON in responses. But they can't detect *patterns over time* — they see each step in isolation.

Without something better, the typical fix is a hardcoded `max_iterations=10` and a prayer.

What's missing is real-time detection of **behavioral patterns**: sequences of agent actions that indicate something has gone wrong.

## Six Failure Modes You've Probably Seen

| Pattern | What Happens | Real-World Example |
|---|---|---|
| Retry Storm | Same tool call with identical params, over and over | Agent keeps searching for "weather in paris" because the API returns an error and the LLM regenerates the same call |
| Circular Reasoning | Agent alternates between tools without progressing | search → read_file → search → read_file, forever |
| Budget Runaway | Cumulative token/cost spend spirals | Agent generates increasingly long prompts trying to "think harder" |
| Error Spiral | Tool error → reformulate → tool error → reformulate | API is down, agent tries different formulations but they all fail |
| Stuck Agent | Many steps without producing output | 30 rounds of "let me think about this" without an answer |
| Token Velocity Spike | Sudden increase in tokens per step | Agent switches from efficient queries to dumping entire documents into context |

## The Solution: Regex for Event Streams

We built [Varpulis Agent Runtime](https://github.com/varpulis/varpulis-agent-runtime), an open-source library that detects these patterns in real-time. Think of it as regex for event streams, applied to AI agent behavior.

The runtime is built on the **Varpulis CEP engine** — an NFA-based pattern matching engine with Kleene closure support, written in Rust. It compiles to WASM for JavaScript or a native Python extension via PyO3. Runs in-process with sub-millisecond latency — no network calls, no infrastructure. 316KB WASM bundle.

Each behavioral pattern is a Kleene closure expression — the `+` operator matches one or more repetitions:

```
retry_storm:         same_tool_call{3+} within 10s
error_spiral:        tool_error{3+} within 30s
stuck_agent:         step{no_output}{15+}, reset on final_answer
circular_reasoning:  A → B → A → B (cross-event name matching)
budget_runaway:      llm_call{+} within 60s where sum(cost) > threshold
```

The Kleene closure is backed by **Zero-suppressed Decision Diagrams (ZDD)** to avoid exponential blowup. When 20 events match a Kleene pattern, there are naively 2^20 (~1M) possible combinations. The ZDD represents all of them in ~100 nodes — not 1M explicit states.

## It Caught Itself: Self-Correcting Agents

We didn't just build a monitoring library — we built a **feedback loop**.

We wired Varpulis into [Claude Code](https://claude.com/claude-code) (Anthropic's CLI agent) using its native HTTP hook system. The monitor runs as a tiny Flask daemon, receives every tool call, feeds them through the CEP engine, and **injects detections back into the agent's context**.

The setup is three lines of config:

```json
{
  "hooks": {
    "PreToolUse": [{ "hooks": [{ "type": "http", "url": "http://localhost:7890/event" }] }],
    "PostToolUse": [{ "hooks": [{ "type": "http", "url": "http://localhost:7890/event" }] }]
  }
}
```

When a pattern fires, the monitor returns `additionalContext` in the hook response — and the agent receives it as guidance on its next turn. For kill-level detections, it returns `permissionDecision: "deny"` which blocks the tool call entirely.

**And it caught a real pattern during its own development.** The CEP engine detected:

> `[WARNING] circular_reasoning: Circular pattern: Edit → Bash → Edit → Bash`
> `Suggestion: You are alternating between the same tools in a loop. Break the cycle by trying a completely different approach.`

The agent was in an edit-restart-edit-restart cycle — a legitimate development workflow, but the engine correctly identified the repeating sequence. In a production scenario with a misbehaving agent, this same detection would break the loop and redirect the agent before it wastes time and money.

This is the real promise: **agents that monitor their own behavior and self-correct in real-time.** The [Claude Code monitor example](https://github.com/varpulis/varpulis-agent-runtime/tree/master/examples/claude-code-monitor) includes the full setup with a live web dashboard.

## Integration in 10 Lines

### Python

```bash
pip install varpulis-agent-runtime
```

```python
from varpulis_agent_runtime import VarpulisAgentRuntime, Patterns

runtime = VarpulisAgentRuntime(patterns=[
    Patterns.retry_storm(min_repetitions=3, kill_threshold=5),
    Patterns.budget_runaway(max_cost_usd=0.50),
    Patterns.stuck_agent(max_steps_without_output=10),
])

@runtime.on("budget_runaway")
def handle(detection):
    if detection["action"] == "kill":
        raise SystemExit("Budget exceeded")
```

### JavaScript/TypeScript

```bash
npm install @varpulis/agent-runtime
```

```typescript
import { VarpulisAgentRuntime, Patterns } from '@varpulis/agent-runtime';
import { WasmAgentRuntime } from '@varpulis/agent-runtime/wasm';

const wasm = new WasmAgentRuntime();
const runtime = new VarpulisAgentRuntime(wasm, {
  patterns: [
    Patterns.retryStorm({ min_repetitions: 3, kill_threshold: 5 }),
    Patterns.budgetRunaway({ max_cost_usd: 0.50 }),
    Patterns.stuckAgent({ max_steps_without_output: 10 }),
  ],
});

runtime.on('budget_runaway', (d) => {
  if (d.action === 'kill') {
    console.error('Budget exceeded — stopping agent');
    process.exit(1);
  }
});
```

### LangChain

```python
from varpulis_agent_runtime.integrations.langchain import VarpulisCallbackHandler

handler = VarpulisCallbackHandler(runtime)
agent.invoke({"input": "..."}, config={"callbacks": [handler]})
```

The handler translates LangChain events into Varpulis events automatically. When a kill-worthy detection fires, it throws `VarpulisKillError` to stop the agent.

## What's Next

We're building this in the open at [github.com/varpulis/varpulis-agent-runtime](https://github.com/varpulis/varpulis-agent-runtime). The library is Apache 2.0 licensed and has 103 tests including Playwright e2e tests that run the full engine in a real Chromium browser.

We'd love to hear which failure modes matter most to you and what patterns are missing. Open an issue or drop by the repo.
