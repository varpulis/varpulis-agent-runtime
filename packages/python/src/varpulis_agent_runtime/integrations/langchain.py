"""LangChain integration for Varpulis Agent Runtime.

Usage:
    from varpulis_agent_runtime.integrations.langchain import VarpulisCallbackHandler
    handler = VarpulisCallbackHandler(runtime)
    agent.run("task", callbacks=[handler])
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


class VarpulisCallbackHandler:
    """LangChain callback handler that feeds events to Varpulis for pattern detection.

    Implements the BaseCallbackHandler protocol without importing langchain-core.
    """

    name = "VarpulisCallbackHandler"

    def __init__(self, runtime: VarpulisAgentRuntime) -> None:
        self.runtime = runtime
        self._step_counter = 0
        self._tool_runs: dict[str, str] = {}  # run_id -> tool_name

    def on_tool_start(
        self, serialized: dict[str, Any], input_str: str, *, run_id: Any = None, **kwargs: Any
    ) -> None:
        tool_name = serialized.get("name", "unknown_tool")
        if run_id:
            self._tool_runs[str(run_id)] = tool_name

        try:
            params = json.loads(input_str) if isinstance(input_str, str) else input_str
        except (json.JSONDecodeError, TypeError):
            params = {"input": str(input_str)}

        self.runtime.observe(
            event_type={
                "type": "ToolCall",
                "name": tool_name,
                "params_hash": _hash_params(params),
                "duration_ms": 0,
            }
        )

    def on_tool_end(self, output: str, *, run_id: Any = None, **kwargs: Any) -> None:
        tool_name = self._tool_runs.pop(str(run_id), "unknown_tool") if run_id else "unknown_tool"
        self.runtime.observe(
            event_type={"type": "ToolResult", "name": tool_name, "success": True}
        )

    def on_tool_error(self, error: BaseException, *, run_id: Any = None, **kwargs: Any) -> None:
        tool_name = self._tool_runs.pop(str(run_id), "unknown_tool") if run_id else "unknown_tool"
        self.runtime.observe(
            event_type={
                "type": "ToolResult",
                "name": tool_name,
                "success": False,
                "error": str(error),
            }
        )

    def on_llm_end(self, response: Any, *, run_id: Any = None, **kwargs: Any) -> None:
        input_tokens = 0
        output_tokens = 0

        if hasattr(response, "llm_output") and response.llm_output:
            usage = response.llm_output.get("token_usage", {})
            input_tokens = usage.get("prompt_tokens", 0)
            output_tokens = usage.get("completion_tokens", 0)

        self.runtime.observe(
            event_type={
                "type": "LlmCall",
                "model": "langchain",
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cost_usd": 0,
            }
        )

    def on_chain_start(
        self, serialized: dict[str, Any], inputs: dict[str, Any], *, run_id: Any = None, **kwargs: Any
    ) -> None:
        self._step_counter += 1
        self.runtime.observe(
            event_type={"type": "StepStart", "step_number": self._step_counter}
        )

    def on_chain_end(self, outputs: dict[str, Any], *, run_id: Any = None, **kwargs: Any) -> None:
        produced_output = bool(outputs) and any(v is not None and v != "" for v in outputs.values())
        self.runtime.observe(
            event_type={
                "type": "StepEnd",
                "step_number": self._step_counter,
                "produced_output": produced_output,
            }
        )
