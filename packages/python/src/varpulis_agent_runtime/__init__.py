"""Varpulis Agent Runtime — Real-time behavioral guardrails for AI agents."""

from varpulis_agent_runtime.runtime import VarpulisAgentRuntime
from varpulis_agent_runtime.patterns import Patterns
from varpulis_agent_runtime.auto import init
from varpulis_agent_runtime.health import HealthScoreTracker
from varpulis_agent_runtime.history import DetectionHistory
from varpulis_agent_runtime.learn import LearnProposal, propose_rule, is_duplicate, apply_rule
from varpulis_agent_runtime.convergent import ConvergentFailureTracker

__all__ = [
    "VarpulisAgentRuntime",
    "Patterns",
    "init",
    "HealthScoreTracker",
    "DetectionHistory",
    "LearnProposal",
    "propose_rule",
    "is_duplicate",
    "apply_rule",
    "ConvergentFailureTracker",
]
