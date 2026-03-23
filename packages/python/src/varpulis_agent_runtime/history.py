"""Cross-session detection history tracking."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class DetectionHistory:
    """Tracks pattern detections across sessions for Learn tier triggering."""

    def __init__(self, data: dict[str, Any] | None = None):
        self._records: dict[str, dict[str, Any]] = data or {}

    def record(self, pattern_name: str, session_id: str) -> dict[str, Any]:
        """Record a detection. Returns the updated record."""
        rec = self._records.get(pattern_name, {
            "count": 0,
            "last_seen": "",
            "sessions": [],
            "learn_applied": False,
        })
        rec["count"] += 1
        rec["last_seen"] = datetime.now(timezone.utc).isoformat()
        if session_id not in rec["sessions"]:
            rec["sessions"].append(session_id)
        self._records[pattern_name] = rec
        return rec

    def should_learn(self, pattern_name: str, threshold: int = 3) -> bool:
        """Check if a pattern should trigger the Learn tier."""
        rec = self._records.get(pattern_name)
        if not rec:
            return False
        return (
            len(rec["sessions"]) >= threshold
            and not rec["learn_applied"]
        )

    def mark_learned(self, pattern_name: str) -> None:
        if pattern_name in self._records:
            self._records[pattern_name]["learn_applied"] = True

    def to_dict(self) -> dict[str, Any]:
        return dict(self._records)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> DetectionHistory:
        return cls(data)

    @classmethod
    def load(cls, path: str | Path) -> DetectionHistory:
        """Load from a JSON file. Returns empty history if file doesn't exist."""
        p = Path(path)
        if p.exists():
            return cls(json.loads(p.read_text()))
        return cls()

    def save(self, path: str | Path) -> None:
        """Persist to a JSON file."""
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(self._records, indent=2))
