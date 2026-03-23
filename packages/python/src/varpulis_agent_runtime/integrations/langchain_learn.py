"""LangChain Learn adapter — persistent mutations from recurring detections.

Maps the Learn tier to LangChain's mutation surfaces:
- System prompt rules
- Tool description addenda
- Tool input guards (pre-call validators)
- Agent config overrides (max_iterations, etc.)

Config is persisted to .varpulis/langchain_config.json and loaded at
agent construction time.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from varpulis_agent_runtime.history import DetectionHistory


class LangChainLearnAdapter:
    """Applies Learn tier mutations to LangChain agents."""

    def __init__(self, config_path: str | Path = ".varpulis/langchain_config.json"):
        self._config_path = Path(config_path)
        self._config = self._load_config()

    # -----------------------------------------------------------------
    # Surface 1: System Prompt Rules
    # -----------------------------------------------------------------

    def append_system_rule(self, rule: str, source_pattern: str) -> None:
        """Append a behavioral rule to the agent's system prompt.

        Rules are persisted and injected into the SystemMessage at
        agent construction time via ``load_system_rules()``.
        """
        existing = [r["rule"] for r in self._config.get("system_rules", [])]
        if rule in existing:
            return
        self._config.setdefault("system_rules", []).append({
            "rule": rule,
            "source_pattern": source_pattern,
            "added_at": datetime.now(timezone.utc).isoformat(),
        })
        self._save_config()

    def load_system_rules(self) -> list[str]:
        """Return all learned system rules for injection into the prompt."""
        return [r["rule"] for r in self._config.get("system_rules", [])]

    # -----------------------------------------------------------------
    # Surface 2: Tool Description Addenda
    # -----------------------------------------------------------------

    def update_tool_description(
        self, tool_name: str, addendum: str, source_pattern: str
    ) -> None:
        """Append usage instructions to a tool's description.

        Apply with ``patch_tool_descriptions(tools)`` at agent construction.
        """
        self._config.setdefault("tool_addenda", {})[tool_name] = {
            "addendum": addendum,
            "source_pattern": source_pattern,
            "added_at": datetime.now(timezone.utc).isoformat(),
        }
        self._save_config()

    def patch_tool_descriptions(self, tools: list[Any]) -> list[Any]:
        """Patch tool descriptions with learned addenda. Mutates in place."""
        addenda = self._config.get("tool_addenda", {})
        for tool in tools:
            name = getattr(tool, "name", None)
            if name and name in addenda:
                desc = getattr(tool, "description", "") or ""
                suffix = f"\n\nIMPORTANT: {addenda[name]['addendum']}"
                if suffix not in desc:
                    tool.description = desc + suffix
        return tools

    # -----------------------------------------------------------------
    # Surface 3: Tool Input Guards
    # -----------------------------------------------------------------

    def add_tool_guard(
        self,
        tool_name: str,
        block_pattern: str,
        message: str,
        source_pattern: str,
    ) -> None:
        """Register a tool input guard (persisted).

        Guards are applied via ``create_tool_wrappers(tools)`` at
        agent construction.
        """
        guards = self._config.setdefault("tool_guards", [])
        # Deduplicate by tool_name + block_pattern
        for g in guards:
            if g["tool_name"] == tool_name and g["block_pattern"] == block_pattern:
                return
        guards.append({
            "tool_name": tool_name,
            "block_pattern": block_pattern,
            "message": message,
            "source_pattern": source_pattern,
            "added_at": datetime.now(timezone.utc).isoformat(),
        })
        self._save_config()

    def get_tool_guards(self) -> list[dict[str, Any]]:
        """Return all registered tool guards."""
        return list(self._config.get("tool_guards", []))

    # -----------------------------------------------------------------
    # Surface 4: Agent Config Overrides
    # -----------------------------------------------------------------

    def update_agent_config(self, updates: dict[str, Any], source_pattern: str) -> None:
        """Persistently update agent configuration (max_iterations, etc.)."""
        self._config.setdefault("runnable_config", {}).update(updates)
        self._config.setdefault("config_log", []).append({
            "updates": updates,
            "source_pattern": source_pattern,
            "applied_at": datetime.now(timezone.utc).isoformat(),
        })
        self._save_config()

    def load_agent_config(self) -> dict[str, Any]:
        """Return learned agent config overrides."""
        return dict(self._config.get("runnable_config", {}))

    # -----------------------------------------------------------------
    # Auto-learn from detections
    # -----------------------------------------------------------------

    _LEARN_MAP: dict[str, Callable[["LangChainLearnAdapter", dict[str, Any]], None]] = {}

    def evaluate(
        self,
        detection: dict[str, Any],
        history: DetectionHistory,
        session_id: str,
        *,
        threshold: int = 3,
    ) -> bool:
        """Evaluate a detection for Learn tier action.

        Returns True if a learn action was applied.
        """
        pattern = detection.get("pattern_name", "")
        history.record(pattern, session_id)

        forced = pattern in ("GitPushViolation", "ConfigOverwriteViolation")
        if not forced and not history.should_learn(pattern, threshold):
            return False

        handler = _PATTERN_HANDLERS.get(pattern)
        if not handler:
            return False

        handler(self, detection)
        history.mark_learned(pattern)
        return True

    # -----------------------------------------------------------------
    # Internals
    # -----------------------------------------------------------------

    def _load_config(self) -> dict[str, Any]:
        if self._config_path.exists():
            return json.loads(self._config_path.read_text())
        return {}

    def _save_config(self) -> None:
        self._config_path.parent.mkdir(parents=True, exist_ok=True)
        self._config_path.write_text(json.dumps(self._config, indent=2))


# ---------------------------------------------------------------------------
# Pattern → Learn action handlers
# ---------------------------------------------------------------------------

def _learn_retry_storm(adapter: LangChainLearnAdapter, detection: dict[str, Any]) -> None:
    tool = detection.get("details", {}).get("tool_name", "")
    if tool:
        adapter.update_tool_description(
            tool,
            "Do not call this tool twice with the same parameters. If it fails, try a different approach.",
            "retry_storm",
        )


def _learn_stuck_agent(adapter: LangChainLearnAdapter, detection: dict[str, Any]) -> None:
    adapter.update_agent_config({"max_iterations": 12}, "stuck_agent")
    adapter.append_system_rule(
        "If you have not produced useful output after 10 steps, stop and summarize your findings.",
        "stuck_agent",
    )


def _learn_error_spiral(adapter: LangChainLearnAdapter, detection: dict[str, Any]) -> None:
    adapter.append_system_rule(
        "When multiple tool calls fail in succession, stop and analyze the root cause before retrying.",
        "error_spiral",
    )


def _learn_circular_reasoning(adapter: LangChainLearnAdapter, detection: dict[str, Any]) -> None:
    adapter.append_system_rule(
        "After calling tool A then tool B, you must produce a synthesis before calling either tool again.",
        "circular_reasoning",
    )


def _learn_budget_runaway(adapter: LangChainLearnAdapter, detection: dict[str, Any]) -> None:
    adapter.update_agent_config({"max_tokens": 50000}, "budget_runaway")


def _learn_intent_stall(adapter: LangChainLearnAdapter, detection: dict[str, Any]) -> None:
    adapter.append_system_rule(
        "When producing output, call the tool immediately. Do not describe what you will do before doing it.",
        "IntentStall",
    )


_PATTERN_HANDLERS: dict[str, Callable[[LangChainLearnAdapter, dict[str, Any]], None]] = {
    "retry_storm": _learn_retry_storm,
    "stuck_agent": _learn_stuck_agent,
    "error_spiral": _learn_error_spiral,
    "circular_reasoning": _learn_circular_reasoning,
    "budget_runaway": _learn_budget_runaway,
    "IntentStall": _learn_intent_stall,
}
