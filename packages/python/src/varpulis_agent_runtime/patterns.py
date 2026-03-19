"""Pattern configuration builders."""

from __future__ import annotations

from typing import Any


class Patterns:
    """Builder helpers for pre-packaged pattern configurations."""

    @staticmethod
    def retry_storm(**kwargs: Any) -> dict[str, Any]:
        return {"type": "retry_storm", "config": kwargs}

    @staticmethod
    def stuck_agent(**kwargs: Any) -> dict[str, Any]:
        return {"type": "stuck_agent", "config": kwargs}

    @staticmethod
    def error_spiral(**kwargs: Any) -> dict[str, Any]:
        return {"type": "error_spiral", "config": kwargs}

    @staticmethod
    def budget_runaway(**kwargs: Any) -> dict[str, Any]:
        return {"type": "budget_runaway", "config": kwargs}

    @staticmethod
    def token_velocity(**kwargs: Any) -> dict[str, Any]:
        return {"type": "token_velocity", "config": kwargs}

    @staticmethod
    def circular_reasoning(**kwargs: Any) -> dict[str, Any]:
        return {"type": "circular_reasoning", "config": kwargs}

    @staticmethod
    def defaults() -> list[dict[str, Any]]:
        return [
            Patterns.retry_storm(),
            Patterns.stuck_agent(),
            Patterns.error_spiral(),
            Patterns.budget_runaway(),
            Patterns.token_velocity(),
            Patterns.circular_reasoning(),
        ]
