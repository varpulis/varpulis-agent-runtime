"""
Real-world LangChain failure scenarios with Varpulis detection.

Shows what happens when an agent:
1. Retries a failing API 5 times (retry storm)
2. Gets stuck in a search->read->search->read loop (circular reasoning -- disabled by default)
3. Burns through tokens with increasingly long prompts (budget runaway)
4. Makes 20 tool calls without answering (stuck agent)
5. Encounters 4 consecutive API errors (error spiral)

Each scenario uses the Varpulis runtime directly (no LLM needed).
Run:  pip install varpulis-agent-runtime && python main.py
"""

import time
from varpulis_agent_runtime import VarpulisAgentRuntime, Patterns


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def separator(title: str) -> None:
    print(f"\n{'=' * 70}")
    print(f"  SCENARIO: {title}")
    print(f"{'=' * 70}")


def print_detection(d: dict) -> None:
    severity = d.get("severity", "?").upper()
    pattern = d.get("pattern_name", "?")
    message = d.get("message", "")
    action = d.get("action", "alert")
    marker = "!!!" if action == "kill" else ">>>"
    print(f"  {marker} [{severity}] {pattern}: {message}")


# ---------------------------------------------------------------------------
# Scenario 1: Retry Storm
#
# Backstory: The agent is trying to answer "What is the current weather in
# Tokyo?" using a DuckDuckGo search tool. The API is rate-limited and returns
# 429 Too Many Requests. The agent blindly retries the same query 5 times.
# ---------------------------------------------------------------------------

def scenario_retry_storm() -> None:
    separator("Retry Storm -- agent hammers a rate-limited search API")

    runtime = VarpulisAgentRuntime(
        patterns=[
            Patterns.retry_storm(min_repetitions=3, window_seconds=30),
        ],
        cooldown_ms=0,
    )
    runtime.on_detection(print_detection)

    t = int(time.time() * 1000)

    print()
    print("  Agent asks: 'What is the current weather in Tokyo?'")
    print("  Tool: duckduckgo_search('weather Tokyo current')")
    print()

    query_hash = 0xA1B2C3D4  # simulated hash of {"query": "weather Tokyo current"}

    for attempt in range(1, 6):
        # LLM decides to call the tool
        t += 800
        runtime.observe(
            timestamp=t,
            event_type={
                "type": "LlmCall",
                "model": "gpt-4o-mini",
                "input_tokens": 320 + (attempt * 80),  # context grows each retry
                "output_tokens": 45,
                "cost_usd": 0.0004,
            },
        )

        # Tool call
        t += 200
        runtime.observe(
            timestamp=t,
            event_type={
                "type": "ToolCall",
                "name": "duckduckgo_search",
                "params_hash": query_hash,
                "duration_ms": 1200,
            },
        )

        # Tool fails
        t += 1200
        runtime.observe(
            timestamp=t,
            event_type={
                "type": "ToolResult",
                "name": "duckduckgo_search",
                "success": False,
                "error": "429 Too Many Requests: Rate limit exceeded",
            },
        )

        print(f"  attempt {attempt}/5: duckduckgo_search -> 429 Too Many Requests")

    print(f"\n  Events processed: {runtime.event_count}")


# ---------------------------------------------------------------------------
# Scenario 2: Circular Reasoning (opt-in, disabled in auto-init defaults)
#
# Backstory: The agent is researching "quantum computing vs classical
# computing". It searches Wikipedia, reads an article, finds a reference,
# searches again, reads again... in an infinite loop.
# ---------------------------------------------------------------------------

def scenario_circular_reasoning() -> None:
    separator("Circular Reasoning -- agent trapped in search/read loop")

    runtime = VarpulisAgentRuntime(
        patterns=[
            Patterns.circular_reasoning(max_cycle_length=4, min_cycle_repetitions=2),
        ],
        cooldown_ms=0,
    )
    runtime.on_detection(print_detection)

    t = int(time.time() * 1000)

    print()
    print("  Agent asks: 'Compare quantum and classical computing'")
    print("  The agent alternates: wikipedia_search -> read_article -> wikipedia_search -> ...")
    print()

    tools_in_cycle = [
        ("wikipedia_search", 0xDEAD0001),
        ("read_article",     0xDEAD0002),
    ]

    cycle_num = 0
    for rep in range(4):  # 4 repetitions of the 2-tool cycle
        for tool_name, phash in tools_in_cycle:
            cycle_num += 1
            t += 1500

            # LLM call deciding to use the tool
            runtime.observe(
                timestamp=t,
                event_type={
                    "type": "LlmCall",
                    "model": "gpt-4o-mini",
                    "input_tokens": 500 + (cycle_num * 200),
                    "output_tokens": 60,
                    "cost_usd": 0.0006,
                },
            )

            t += 300
            runtime.observe(
                timestamp=t,
                event_type={
                    "type": "ToolCall",
                    "name": tool_name,
                    "params_hash": phash,
                    "duration_ms": 800,
                },
            )

            t += 800
            runtime.observe(
                timestamp=t,
                event_type={
                    "type": "ToolResult",
                    "name": tool_name,
                    "success": True,
                },
            )

            status = "found 3 results" if "search" in tool_name else "read 2,400 words"
            print(f"  step {cycle_num}: {tool_name} -> {status}")

    print(f"\n  Events processed: {runtime.event_count}")


# ---------------------------------------------------------------------------
# Scenario 3: Budget Runaway
#
# Backstory: The agent is writing a research report. Each iteration adds
# more context to the prompt (retrieved docs, previous drafts). Token usage
# snowballs from 1k to 8k+ per call. Cost crosses the threshold.
# ---------------------------------------------------------------------------

def scenario_budget_runaway() -> None:
    separator("Budget Runaway -- token usage snowballs during research task")

    runtime = VarpulisAgentRuntime(
        patterns=[
            Patterns.budget_runaway(
                max_cost_usd=0.10,
                max_tokens=5000,
                window_seconds=120,
            ),
        ],
        cooldown_ms=0,
    )
    runtime.on_detection(print_detection)

    t = int(time.time() * 1000)

    print()
    print("  Agent task: 'Write a comprehensive report on renewable energy'")
    print("  Each iteration retrieves more docs, growing the prompt...")
    print()

    # Simulate escalating LLM calls -- the prompt grows each time
    calls = [
        # (input_tokens, output_tokens, cost, description)
        (400,  200,  0.005, "initial outline"),
        (800,  300,  0.009, "search + first draft"),
        (1200, 400,  0.013, "add solar energy section"),
        (1600, 500,  0.017, "add wind energy section"),
        (2000, 350,  0.019, "add hydro section + revise"),
        (2400, 600,  0.024, "add comparison table"),
        (2800, 500,  0.027, "add citations + conclusion"),
        (3200, 700,  0.032, "full revision pass"),
    ]

    running_cost = 0.0
    running_tokens = 0

    for i, (inp, out, cost, desc) in enumerate(calls, 1):
        t += 3000
        running_cost += cost
        running_tokens += inp + out

        runtime.observe(
            timestamp=t,
            event_type={
                "type": "LlmCall",
                "model": "claude-sonnet-4-20250514",
                "input_tokens": inp,
                "output_tokens": out,
                "cost_usd": cost,
            },
        )

        print(f"  call {i}: {desc:30s}  tokens={inp+out:5d}  cumulative=${running_cost:.3f}  total_tokens={running_tokens}")

    print(f"\n  Events processed: {runtime.event_count}")


# ---------------------------------------------------------------------------
# Scenario 4: Stuck Agent
#
# Backstory: The agent is asked "Plan a 7-day trip to Japan." It enters a
# planning loop -- calling tools to search flights, hotels, activities --
# but never produces a final answer. After 20 fruitless steps, Varpulis
# flags it.
# ---------------------------------------------------------------------------

def scenario_stuck_agent() -> None:
    separator("Stuck Agent -- 20 tool calls, zero answers")

    runtime = VarpulisAgentRuntime(
        patterns=[
            Patterns.stuck_agent(
                max_steps_without_output=8,
                max_time_without_output_seconds=9999,
            ),
        ],
        cooldown_ms=0,
    )
    runtime.on_detection(print_detection)

    t = int(time.time() * 1000)

    print()
    print("  Agent task: 'Plan a 7-day trip to Japan with budget breakdown'")
    print("  The agent searches, reads, compares... but never commits to an answer.")
    print()

    tools = [
        "flight_search",     "hotel_search",      "activity_search",
        "budget_calculator", "flight_search",      "hotel_search",
        "restaurant_search", "transport_search",   "activity_search",
        "budget_calculator", "flight_search",      "weather_check",
        "hotel_search",      "activity_search",    "currency_convert",
        "budget_calculator", "restaurant_search",  "transport_search",
        "activity_search",   "budget_calculator",
    ]

    for step, tool_name in enumerate(tools, 1):
        # Step start
        t += 2000
        runtime.observe(
            timestamp=t,
            event_type={"type": "StepStart", "step_number": step},
        )

        # LLM call
        t += 500
        runtime.observe(
            timestamp=t,
            event_type={
                "type": "LlmCall",
                "model": "gpt-4o",
                "input_tokens": 600 + (step * 100),
                "output_tokens": 80,
                "cost_usd": 0.003,
            },
        )

        # Tool call
        t += 300
        runtime.observe(
            timestamp=t,
            event_type={
                "type": "ToolCall",
                "name": tool_name,
                "params_hash": hash(f"{tool_name}_{step}") & 0xFFFFFFFF,
                "duration_ms": 600,
            },
        )

        # Tool result (success, but agent doesn't produce final output)
        t += 600
        runtime.observe(
            timestamp=t,
            event_type={
                "type": "ToolResult",
                "name": tool_name,
                "success": True,
            },
        )

        # Step end -- no output produced
        t += 200
        runtime.observe(
            timestamp=t,
            event_type={
                "type": "StepEnd",
                "step_number": step,
                "produced_output": False,
            },
        )

        print(f"  step {step:2d}: {tool_name:20s} -> got data, still thinking...")

    print(f"\n  Events processed: {runtime.event_count}")


# ---------------------------------------------------------------------------
# Scenario 5: Error Spiral
#
# Backstory: The agent is trying to look up stock prices. The upstream API
# returns different errors -- 503, timeout, invalid response -- and the
# agent tries different tools, all of which fail. The whole tool layer is
# down, but the agent keeps trying.
# ---------------------------------------------------------------------------

def scenario_error_spiral() -> None:
    separator("Error Spiral -- cascading failures across multiple tools")

    runtime = VarpulisAgentRuntime(
        patterns=[
            Patterns.error_spiral(min_error_count=3, window_seconds=60),
        ],
        cooldown_ms=0,
    )
    runtime.on_detection(print_detection)

    t = int(time.time() * 1000)

    print()
    print("  Agent asks: 'What are the top-performing tech stocks this week?'")
    print("  Every tool the agent tries is failing...")
    print()

    errors = [
        ("stock_price_api",   "503 Service Unavailable"),
        ("yahoo_finance",     "ConnectionTimeout after 30s"),
        ("web_search",        "SSL certificate verify failed"),
        ("news_api",          "401 Unauthorized: API key expired"),
        ("stock_price_api",   "503 Service Unavailable"),
        ("web_search",        "ConnectionResetError: [Errno 104]"),
    ]

    for i, (tool_name, error_msg) in enumerate(errors, 1):
        # LLM decides to try another tool
        t += 1500
        runtime.observe(
            timestamp=t,
            event_type={
                "type": "LlmCall",
                "model": "gpt-4o",
                "input_tokens": 400 + (i * 150),
                "output_tokens": 55,
                "cost_usd": 0.002,
            },
        )

        # Tool call
        t += 200
        runtime.observe(
            timestamp=t,
            event_type={
                "type": "ToolCall",
                "name": tool_name,
                "params_hash": hash(f"{tool_name}_{i}") & 0xFFFFFFFF,
                "duration_ms": 2000,
            },
        )

        # Tool fails
        t += 2000
        runtime.observe(
            timestamp=t,
            event_type={
                "type": "ToolResult",
                "name": tool_name,
                "success": False,
                "error": error_msg,
            },
        )

        print(f"  call {i}: {tool_name:20s} -> ERROR: {error_msg}")

    print(f"\n  Events processed: {runtime.event_count}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    print("=" * 70)
    print("  Varpulis Agent Runtime -- Real-World LangChain Failure Scenarios")
    print("=" * 70)
    print()
    print("  Each scenario simulates realistic agent event sequences and shows")
    print("  Varpulis catching the failure pattern in real-time.")
    print("  No LLM API key needed -- events are replayed directly.")

    scenario_retry_storm()
    scenario_circular_reasoning()
    scenario_budget_runaway()
    scenario_stuck_agent()
    scenario_error_spiral()

    print()
    print("=" * 70)
    print("  All 5 failure modes detected. In production, each detection can")
    print("  trigger alerts, kill the agent, or invoke custom recovery logic.")
    print("=" * 70)


if __name__ == "__main__":
    main()
