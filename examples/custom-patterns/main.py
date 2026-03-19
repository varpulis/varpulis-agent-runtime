"""
Custom Patterns Example

Shows how to configure different pattern presets for different environments.
"""

import time
from varpulis_agent_runtime import VarpulisAgentRuntime, Patterns


def strict_production():
    """Aggressive thresholds for customer-facing agents."""
    return VarpulisAgentRuntime(
        patterns=[
            Patterns.retry_storm(min_repetitions=2, window_seconds=5),
            Patterns.stuck_agent(max_steps_without_output=5, max_time_without_output_seconds=30),
            Patterns.error_spiral(min_error_count=2, window_seconds=15),
            Patterns.budget_runaway(max_cost_usd=0.25, max_tokens=25_000, window_seconds=30),
            Patterns.circular_reasoning(max_cycle_length=3, min_cycle_repetitions=2),
            Patterns.token_velocity(baseline_window_steps=3, spike_multiplier=1.5),
        ],
        cooldown_ms=10_000,
    )


def relaxed_development():
    """Lenient thresholds for dev/research agents that need room to explore."""
    return VarpulisAgentRuntime(
        patterns=[
            Patterns.retry_storm(min_repetitions=10, window_seconds=30),
            Patterns.stuck_agent(max_steps_without_output=50, max_time_without_output_seconds=600),
            Patterns.budget_runaway(max_cost_usd=10.00, max_tokens=500_000, window_seconds=300),
        ],
        cooldown_ms=60_000,
    )


def cost_focused():
    """Only monitors budget — useful when cost is the primary concern."""
    return VarpulisAgentRuntime(
        patterns=[
            Patterns.budget_runaway(max_cost_usd=0.50, max_tokens=50_000, window_seconds=60),
        ],
        cooldown_ms=0,
    )


def simulate_expensive_agent(runtime: VarpulisAgentRuntime, label: str):
    """Push a sequence of expensive LLM calls and see what triggers."""
    print(f"\n{'='*50}")
    print(f"  {label}")
    print(f"{'='*50}")

    t = int(time.time() * 1000)
    detection_count = 0

    for i in range(20):
        t += 1000
        dets = runtime.observe(
            timestamp=t,
            event_type={
                "type": "LlmCall",
                "model": "claude-sonnet-4-20250514",
                "input_tokens": 1000,
                "output_tokens": 500,
                "cost_usd": 0.05,
            },
        )
        for d in dets:
            detection_count += 1
            print(f"  [{d['severity'].upper()}] {d['pattern_name']}: {d['message']}")

    print(f"  Events: {runtime.event_count}, Detections: {detection_count}")


def main():
    print("Demonstrating different pattern configurations")
    print("Same agent behavior, different detection thresholds\n")

    simulate_expensive_agent(strict_production(), "STRICT (production)")
    simulate_expensive_agent(relaxed_development(), "RELAXED (development)")
    simulate_expensive_agent(cost_focused(), "COST-FOCUSED")


if __name__ == "__main__":
    main()
