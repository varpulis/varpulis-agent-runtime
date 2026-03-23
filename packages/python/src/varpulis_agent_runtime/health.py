"""Health score computation from active detections."""

from __future__ import annotations

from typing import Any

DEFAULT_WEIGHTS: dict[str, float] = {
    "retry_storm": 0.08,
    "stuck_agent": 0.08,
    "error_spiral": 0.08,
    "budget_runaway": 0.10,
    "token_velocity": 0.04,
    "circular_reasoning": 0.08,
    "IntentStall": 0.12,
    "CompactionSpiral": 0.18,
    "MemoryLossViolation": 0.18,
    "ContextStarvation": 0.03,
    "IdleCompaction": 0.03,
}

SEVERITY_MULTIPLIERS: dict[str, float] = {
    "info": 0.25,
    "warning": 0.5,
    "error": 0.75,
    "critical": 1.0,
}


class HealthScoreTracker:
    """Computes a session health score from active detections.

    Score: 1.0 = healthy, 0.0 = critical.
    """

    def __init__(self, weights: dict[str, float] | None = None):
        self.weights = {**DEFAULT_WEIGHTS, **(weights or {})}

    def compute(self, active_detections: list[dict[str, Any]]) -> float:
        score = 1.0
        for d in active_detections:
            pattern = d.get("pattern_name", "")
            severity = d.get("severity", "info")
            weight = self.weights.get(pattern, 0.05)
            multiplier = SEVERITY_MULTIPLIERS.get(severity, 0.25)
            score -= weight * multiplier
        return max(0.0, score)

    @staticmethod
    def status(score: float) -> str:
        if score >= 0.8:
            return "healthy"
        if score >= 0.5:
            return "degraded"
        if score >= 0.2:
            return "unhealthy"
        return "critical"
