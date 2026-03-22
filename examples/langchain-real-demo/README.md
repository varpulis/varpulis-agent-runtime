# LangChain Real Demo -- Varpulis Catching Agent Failures

End-to-end demonstration of Varpulis detecting real-world LangChain agent failure modes.

## Files

| File | What it does | Requires API key? |
|---|---|---|
| `main.py` | Replays 5 realistic failure scenarios through the Varpulis runtime | No |
| `with_langchain.py` | Shows 3 ways to integrate Varpulis with a real LangChain agent | Yes |

## Quick start

```bash
pip install varpulis-agent-runtime
python main.py
```

No API keys, no LangChain install, no network access needed. The demo pushes realistic agent event sequences directly through `runtime.observe()` and shows Varpulis catching each failure pattern.

## Scenarios in main.py

### 1. Retry Storm

The agent calls `duckduckgo_search` with the same query 5 times because the API returns 429. Varpulis detects the identical repeated tool calls on attempt 3.

### 2. Circular Reasoning

The agent researches a topic by alternating `wikipedia_search` and `read_article` in an infinite loop. Varpulis detects the repeating tool cycle after 2 repetitions.

This pattern is **disabled by default** in `varpulis_agent_runtime.init()` because it can produce false positives during normal development. Enable it explicitly:

```python
from varpulis_agent_runtime import Patterns

runtime = VarpulisAgentRuntime(patterns=[
    *Patterns.defaults(),  # includes circular_reasoning
])
```

### 3. Budget Runaway

The agent writes a research report, retrieving more documents each iteration. Input tokens snowball from 400 to 3,200 per call. Varpulis fires a warning at 80% of the budget threshold and an error at 100%.

### 4. Stuck Agent

The agent calls 20 different tools (flight search, hotel search, budget calculator...) without ever producing a final answer. Varpulis fires after 8 fruitless steps.

### 5. Error Spiral

Every tool the agent tries fails with a different error (503, timeout, SSL error, expired API key). Varpulis detects the cascading failures after 3 consecutive errors, even across different tools.

## Integrating with a real LangChain agent

See `with_langchain.py` for three integration patterns:

**Option 1: Auto-patching (2 lines)**

```python
import varpulis_agent_runtime
varpulis_agent_runtime.init(verbose=True)

# Use LangChain normally -- Varpulis watches automatically
agent.invoke({"input": "..."})
```

**Option 2: Explicit callback handler**

```python
from varpulis_agent_runtime import VarpulisAgentRuntime
from varpulis_agent_runtime.integrations.langchain import VarpulisCallbackHandler

runtime = VarpulisAgentRuntime()
handler = VarpulisCallbackHandler(runtime)

agent.invoke({"input": "..."}, config={"callbacks": [handler]})
```

**Option 3: Custom detection routing**

```python
import varpulis_agent_runtime

def send_to_pagerduty(detection):
    if detection["severity"] in ("error", "critical"):
        pagerduty.trigger(summary=detection["message"])

runtime = varpulis_agent_runtime.init(on_detection=send_to_pagerduty)
```

## Requirements

- `main.py`: Only `varpulis-agent-runtime` (pip install)
- `with_langchain.py`: Also needs `langchain`, `langchain-openai`, `langchain-community`, `duckduckgo-search`, and an `OPENAI_API_KEY`
