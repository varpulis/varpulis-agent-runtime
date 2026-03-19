"""
LangChain Guardrails Example

Simulates a LangChain agent that encounters common failure modes,
with Varpulis detecting each one in real-time.
"""

import time
from varpulis_agent_runtime import VarpulisAgentRuntime, Patterns


def main():
    # Set up runtime with tuned thresholds for this demo
    runtime = VarpulisAgentRuntime(
        patterns=[
            Patterns.retry_storm(min_repetitions=3, window_seconds=10),
            Patterns.error_spiral(min_error_count=3, window_seconds=30),
            Patterns.stuck_agent(max_steps_without_output=5, max_time_without_output_seconds=9999),
            Patterns.budget_runaway(max_cost_usd=0.10, max_tokens=5000, window_seconds=60),
            Patterns.circular_reasoning(max_cycle_length=4, min_cycle_repetitions=2),
        ],
        cooldown_ms=0,
    )

    # Register handlers
    runtime.on("retry_storm", lambda d: print(f"  RETRY STORM: {d['message']}"))
    runtime.on("error_spiral", lambda d: print(f"  ERROR SPIRAL: {d['message']}"))
    runtime.on("stuck_agent", lambda d: print(f"  STUCK AGENT: {d['message']}"))
    runtime.on("budget_runaway", lambda d: print(
        f"  BUDGET {'EXCEEDED' if d['severity'] == 'error' else 'WARNING'}: {d['message']}"
    ))
    runtime.on("circular_reasoning", lambda d: print(f"  CIRCULAR: {d['message']}"))

    t = int(time.time() * 1000)

    # --- Scenario 1: Retry Storm ---
    print("\n=== Scenario 1: Agent retries failing API call ===")
    for i in range(5):
        t += 1000
        runtime.observe(
            timestamp=t,
            event_type={"type": "ToolCall", "name": "search_api", "params_hash": 12345, "duration_ms": 500},
        )
        t += 500
        runtime.observe(
            timestamp=t,
            event_type={"type": "ToolResult", "name": "search_api", "success": False, "error": "503 Service Unavailable"},
        )

    runtime.reset()
    t += 10000

    # --- Scenario 2: Circular Reasoning ---
    print("\n=== Scenario 2: Agent stuck in search-read loop ===")
    for cycle in range(3):
        for tool in ["search", "read_file", "search", "read_file"]:
            t += 1000
            runtime.observe(
                timestamp=t,
                event_type={"type": "ToolCall", "name": tool, "params_hash": hash(tool) & 0xFFFFFFFF, "duration_ms": 200},
            )

    runtime.reset()
    t += 10000

    # --- Scenario 3: Budget Runaway ---
    print("\n=== Scenario 3: Agent burning through API credits ===")
    for i in range(10):
        t += 2000
        runtime.observe(
            timestamp=t,
            event_type={
                "type": "LlmCall",
                "model": "claude-sonnet-4-20250514",
                "input_tokens": 800,
                "output_tokens": 400,
                "cost_usd": 0.015,
            },
        )

    runtime.reset()
    t += 10000

    # --- Scenario 4: Stuck Agent ---
    print("\n=== Scenario 4: Agent thinking without producing output ===")
    for step in range(8):
        t += 3000
        runtime.observe(timestamp=t, event_type={"type": "StepStart", "step_number": step})
        t += 2000
        runtime.observe(
            timestamp=t,
            event_type={"type": "StepEnd", "step_number": step, "produced_output": False},
        )

    print(f"\nTotal events processed: {runtime.event_count}")


if __name__ == "__main__":
    main()
