"""High-level Python wrapper around the native Rust runtime."""

from __future__ import annotations

import json
from typing import Any, Callable

from varpulis_agent_runtime._core import PyAgentRuntime


class VarpulisAgentRuntime:
    """Real-time behavioral pattern detection for AI agents.

    Push agent events via ``observe()`` and receive detections when
    problematic patterns are detected.
    """

    def __init__(self, *, patterns: list[dict[str, Any]] | None = None, cooldown_ms: int | None = None):
        if patterns:
            self._runtime = PyAgentRuntime()
            if cooldown_ms is not None:
                self._runtime.set_cooldown_ms(cooldown_ms)
            for p in patterns:
                ptype = p["type"]
                config = json.dumps(p.get("config", {}))
                adder = getattr(self._runtime, f"add_{ptype}", None)
                if adder is None:
                    raise ValueError(f"Unknown pattern type: {ptype}")
                adder(config)
        else:
            self._runtime = PyAgentRuntime.with_default_patterns()
            if cooldown_ms is not None:
                self._runtime.set_cooldown_ms(cooldown_ms)

        self._listeners: list[Callable[[dict[str, Any]], None]] = []

    def observe(self, *, event_type: dict[str, Any], timestamp: int | None = None, **kwargs: Any) -> list[dict[str, Any]]:
        """Push an event and return any detections."""
        import time

        event = {
            "timestamp": timestamp or int(time.time() * 1000),
            "event_type": event_type,
            **kwargs,
        }
        result_json = self._runtime.observe(json.dumps(event))
        detections: list[dict[str, Any]] = json.loads(result_json)

        for d in detections:
            for listener in self._listeners:
                listener(d)

        return detections

    def on_detection(self, callback: Callable[[dict[str, Any]], None]) -> Callable[[], None]:
        """Register a detection callback. Returns an unsubscribe function."""
        self._listeners.append(callback)

        def unsubscribe() -> None:
            self._listeners.remove(callback)

        return unsubscribe

    def on(self, pattern_name: str, callback: Callable[[dict[str, Any]], None] | None = None) -> Any:
        """Register a callback for a specific pattern.

        Can be used as a decorator or called directly:

            @runtime.on("retry_storm")
            def handle(detection):
                ...

            # or

            runtime.on("retry_storm", handle)
        """
        def _register(cb: Callable[[dict[str, Any]], None]) -> Callable[[dict[str, Any]], None]:
            def filtered(d: dict[str, Any]) -> None:
                if d.get("pattern_name") == pattern_name:
                    cb(d)
            self.on_detection(filtered)
            return cb

        if callback is not None:
            _register(callback)
            return None

        return _register

    def reset(self) -> None:
        """Reset all detector state and cooldowns."""
        self._runtime.reset()

    @property
    def event_count(self) -> int:
        """Number of events processed."""
        return self._runtime.event_count()
