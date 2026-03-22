"""OpenTelemetry SpanProcessor integration for Varpulis Agent Runtime.

Converts OpenTelemetry GenAI semantic convention spans into Varpulis events.

Usage:
    from varpulis_agent_runtime.integrations.opentelemetry import VarpulisSpanProcessor
    from opentelemetry import trace

    processor = VarpulisSpanProcessor(runtime)
    trace.get_tracer_provider().add_span_processor(processor)
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


# GenAI semantic convention span name prefixes.
_GENAI_LLM_SPAN_NAMES = {"gen_ai.chat", "gen_ai.completion"}
_GENAI_TOOL_SPAN_NAME = "gen_ai.tool"

# GenAI semantic convention attribute keys.
_ATTR_OPERATION_NAME = "gen_ai.operation.name"
_ATTR_SYSTEM = "gen_ai.system"
_ATTR_REQUEST_MODEL = "gen_ai.request.model"
_ATTR_RESPONSE_MODEL = "gen_ai.response.model"
_ATTR_INPUT_TOKENS = "gen_ai.usage.input_tokens"
_ATTR_OUTPUT_TOKENS = "gen_ai.usage.output_tokens"
_ATTR_TOOL_NAME = "gen_ai.tool.name"
_ATTR_TOOL_CALL_ID = "gen_ai.tool.call.id"


class VarpulisSpanProcessor:
    """OpenTelemetry SpanProcessor that feeds GenAI spans to Varpulis.

    Implements the SpanProcessor protocol without importing the OTel SDK,
    so it works as a duck-typed processor.

    Usage:
        from varpulis_agent_runtime.integrations.opentelemetry import VarpulisSpanProcessor
        from opentelemetry import trace

        processor = VarpulisSpanProcessor(runtime)
        trace.get_tracer_provider().add_span_processor(processor)
    """

    def __init__(self, runtime: VarpulisAgentRuntime) -> None:
        self.runtime = runtime

    def on_start(self, span: Any, parent_context: Any = None) -> None:
        """Called when a span starts. No-op for this processor."""

    def on_end(self, span: Any) -> None:
        """Called when a span ends. Converts GenAI spans to Varpulis events."""
        span_name = getattr(span, "name", "") or ""
        attributes = getattr(span, "attributes", {}) or {}

        # Determine the GenAI operation from span name or attributes.
        operation = attributes.get(_ATTR_OPERATION_NAME, "")

        if self._is_tool_span(span_name, operation, attributes):
            self._handle_tool_span(span, attributes)
        elif self._is_llm_span(span_name, operation):
            self._handle_llm_span(span, attributes)

    def shutdown(self) -> None:
        """Called when the TracerProvider is shut down."""

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        """Export all ended spans that have not been exported yet.

        This processor does not buffer, so this is a no-op.
        """
        return True

    # -- Private helpers ------------------------------------------------------

    def _is_llm_span(self, span_name: str, operation: str) -> bool:
        """Check if the span represents an LLM call."""
        if operation in ("chat", "completion"):
            return True
        for prefix in _GENAI_LLM_SPAN_NAMES:
            if span_name == prefix or span_name.startswith(prefix + " "):
                return True
        return False

    def _is_tool_span(self, span_name: str, operation: str, attributes: dict[str, Any]) -> bool:
        """Check if the span represents a tool call."""
        if operation == "tool":
            return True
        if span_name == _GENAI_TOOL_SPAN_NAME or span_name.startswith(_GENAI_TOOL_SPAN_NAME + " "):
            return True
        if _ATTR_TOOL_NAME in attributes:
            return True
        return False

    def _handle_tool_span(self, span: Any, attributes: dict[str, Any]) -> None:
        """Convert a tool span into ToolCall + ToolResult events."""
        tool_name = attributes.get(_ATTR_TOOL_NAME, "unknown_tool")

        # Compute duration from span timestamps if available.
        duration_ms = self._span_duration_ms(span)

        # Emit ToolCall event.
        self.runtime.observe(
            event_type={
                "type": "ToolCall",
                "name": tool_name,
                "params_hash": _hash_params({"tool_call_id": attributes.get(_ATTR_TOOL_CALL_ID, "")}),
                "duration_ms": duration_ms,
            }
        )

        # Emit ToolResult event. Consider the span successful if its status is OK
        # or UNSET (no explicit error).
        status = getattr(span, "status", None)
        success = True
        error_msg: str | None = None
        if status is not None:
            status_code = getattr(status, "status_code", None)
            # OTel StatusCode.ERROR has value 2.
            if status_code is not None and (status_code == 2 or str(status_code).endswith("ERROR")):
                success = False
                error_msg = getattr(status, "description", None)

        event: dict[str, Any] = {
            "type": "ToolResult",
            "name": tool_name,
            "success": success,
        }
        if error_msg:
            event["error"] = error_msg

        self.runtime.observe(event_type=event)

    def _handle_llm_span(self, span: Any, attributes: dict[str, Any]) -> None:
        """Convert an LLM span into an LlmCall event."""
        model = (
            attributes.get(_ATTR_RESPONSE_MODEL)
            or attributes.get(_ATTR_REQUEST_MODEL)
            or attributes.get(_ATTR_SYSTEM, "unknown")
        )
        input_tokens = int(attributes.get(_ATTR_INPUT_TOKENS, 0) or 0)
        output_tokens = int(attributes.get(_ATTR_OUTPUT_TOKENS, 0) or 0)

        self.runtime.observe(
            event_type={
                "type": "LlmCall",
                "model": str(model),
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cost_usd": 0,
            }
        )

    def _span_duration_ms(self, span: Any) -> int:
        """Extract span duration in milliseconds from OTel span timestamps."""
        start = getattr(span, "start_time", None)
        end = getattr(span, "end_time", None)
        if start is not None and end is not None:
            try:
                # OTel timestamps are in nanoseconds.
                return max(0, int((end - start) / 1_000_000))
            except (TypeError, ValueError):
                pass
        return 0
