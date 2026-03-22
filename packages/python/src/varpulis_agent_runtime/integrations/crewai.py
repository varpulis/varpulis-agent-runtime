"""CrewAI integration for Varpulis Agent Runtime.

Usage:
    from varpulis_agent_runtime.integrations.crewai import VarpulisCrewAIHook
    hook = VarpulisCrewAIHook(runtime)
    hook.register()  # registers before/after tool hooks globally
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from varpulis_agent_runtime.runtime import VarpulisAgentRuntime


def _hash_params(params: Any) -> int:
    """Compute a deterministic hash of parameters."""
    s = json.dumps(params, sort_keys=True, default=str)
    return int(hashlib.md5(s.encode()).hexdigest()[:8], 16)


class VarpulisCrewAIHook:
    """CrewAI integration for Varpulis Agent Runtime.

    Registers before/after tool call hooks with CrewAI to observe tool
    executions and enforce kill actions when dangerous patterns are detected.

    Usage:
        from varpulis_agent_runtime.integrations.crewai import VarpulisCrewAIHook
        hook = VarpulisCrewAIHook(runtime)
        hook.register()  # registers before/after tool hooks globally
    """

    def __init__(self, runtime: VarpulisAgentRuntime) -> None:
        self.runtime = runtime
        self._registered = False

    def register(self) -> None:
        """Register before/after tool call hooks with CrewAI.

        Raises ImportError if crewai is not installed.
        """
        if self._registered:
            return

        try:
            from crewai import (
                register_before_tool_call_hook,
                register_after_tool_call_hook,
            )
        except ImportError:
            raise ImportError(
                "crewai is required for this integration. "
                "Install it with: pip install crewai"
            )

        register_before_tool_call_hook(self._before_tool_call)
        register_after_tool_call_hook(self._after_tool_call)
        self._registered = True

    def _before_tool_call(self, context: Any) -> bool | None:
        """Called before each CrewAI tool execution.

        Translates the hook context into a ToolCall event and observes it.
        Returns False if any detection has action="kill", blocking execution.
        """
        tool_name = getattr(context, "tool_name", "unknown_tool")
        tool_input = getattr(context, "tool_input", {})

        if isinstance(tool_input, str):
            try:
                params = json.loads(tool_input)
            except (json.JSONDecodeError, TypeError):
                params = {"input": tool_input}
        elif isinstance(tool_input, dict):
            params = tool_input
        else:
            params = {"input": str(tool_input)}

        detections = self.runtime.observe(
            event_type={
                "type": "ToolCall",
                "name": tool_name,
                "params_hash": _hash_params(params),
                "duration_ms": 0,
            }
        )

        # If any detection has action="kill", block the tool execution.
        for detection in detections:
            if detection.get("action") == "kill":
                return False

        return None

    def _after_tool_call(self, context: Any) -> None:
        """Called after each CrewAI tool execution.

        Translates the hook context into a ToolResult event and observes it.
        """
        tool_name = getattr(context, "tool_name", "unknown_tool")
        tool_result = getattr(context, "tool_result", None)

        success = tool_result is not None

        self.runtime.observe(
            event_type={
                "type": "ToolResult",
                "name": tool_name,
                "success": success,
            }
        )
