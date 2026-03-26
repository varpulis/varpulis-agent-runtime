"""Cross-session convergent failure tracking.

Aggregates per-session targeted_failure detections by failure target.
When N distinct sessions fail on the same target within a time window,
emits a stale guardrail proposal for human review.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class ConvergentFailureTracker:
    """Tracks failure targets across sessions to detect stale guardrails.

    Usage:
        1. When a per-session targeted_failure detection fires, call record().
        2. If record() returns a dict (proposal), write it to the proposals directory.
        3. Persist state between restarts via to_dict()/from_dict() or save()/load().
    """

    def __init__(
        self,
        *,
        session_threshold: int = 3,
        window_seconds: int = 3600,
        proposal_dir: str = ".varpulis/proposals",
    ):
        self.session_threshold = session_threshold
        self.window_seconds = window_seconds
        self.proposal_dir = proposal_dir
        self._records: dict[str, dict[str, Any]] = {}
        self._emitted: set[str] = set()

    def record(
        self,
        target: str,
        session_id: str,
        error_summary: str,
        task_description: str | None = None,
    ) -> dict[str, Any] | None:
        """Record a per-session targeted failure detection.

        Returns a stale guardrail proposal dict if the threshold is met, else None.
        """
        now = datetime.now(timezone.utc).isoformat()

        rec = self._records.get(target)
        if rec is None:
            rec = {
                "target": target,
                "sessions": [],
                "first_seen": now,
                "last_seen": now,
            }
            self._records[target] = rec

        # Prune old evidence outside the window
        import time as _time

        cutoff_ms = _time.time() * 1000 - self.window_seconds * 1000
        rec["sessions"] = [
            s
            for s in rec["sessions"]
            if _parse_ts(s["timestamp"]) >= cutoff_ms
        ]

        # Add evidence if session not already recorded for this target
        existing = any(s["session_id"] == session_id for s in rec["sessions"])
        if not existing:
            evidence: dict[str, Any] = {
                "session_id": session_id,
                "timestamp": now,
                "error_summary": error_summary,
            }
            if task_description:
                evidence["task_description"] = task_description
            rec["sessions"].append(evidence)

        rec["last_seen"] = now

        # Check threshold
        distinct = len({s["session_id"] for s in rec["sessions"]})
        if distinct >= self.session_threshold and target not in self._emitted:
            self._emitted.add(target)
            return self._build_proposal(rec)

        return None

    def get_pending_targets(self) -> list[dict[str, Any]]:
        """Get all records that have met the session threshold."""
        results = []
        for rec in self._records.values():
            distinct = len({s["session_id"] for s in rec["sessions"]})
            if distinct >= self.session_threshold:
                results.append(rec)
        return results

    def get_all_records(self) -> list[dict[str, Any]]:
        """Get all tracked records (for dashboard display)."""
        return list(self._records.values())

    def to_dict(self) -> dict[str, Any]:
        """Export for persistence."""
        return {
            "records": dict(self._records),
            "emitted": list(self._emitted),
        }

    @classmethod
    def from_dict(
        cls,
        data: dict[str, Any],
        **kwargs: Any,
    ) -> ConvergentFailureTracker:
        """Restore from persisted data."""
        tracker = cls(**kwargs)
        tracker._records = dict(data.get("records", {}))
        tracker._emitted = set(data.get("emitted", []))
        return tracker

    def save(self, path: str | Path) -> None:
        """Persist to a JSON file."""
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(self.to_dict(), indent=2))

    @classmethod
    def load(cls, path: str | Path, **kwargs: Any) -> ConvergentFailureTracker:
        """Load from a JSON file. Returns empty tracker if file doesn't exist."""
        p = Path(path)
        if p.exists():
            data = json.loads(p.read_text())
            return cls.from_dict(data, **kwargs)
        return cls(**kwargs)

    def _build_proposal(self, rec: dict[str, Any]) -> dict[str, Any]:
        sessions = rec["sessions"]
        distinct = len({s["session_id"] for s in sessions})
        tasks = [s["task_description"] for s in sessions if s.get("task_description")]
        task_context = f" with different tasks ({', '.join(tasks)})" if tasks else ""

        return {
            "type": "stale_guardrail",
            "target": rec["target"],
            "evidence": list(sessions),
            "session_count": distinct,
            "first_seen": rec["first_seen"],
            "last_seen": rec["last_seen"],
            "recommendation": (
                f"Target '{rec['target']}' may be outdated — {distinct} independent "
                f"sessions failed on it{task_context}. "
                f"Consider updating or removing this guardrail."
            ),
            "status": "pending",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }


def _parse_ts(iso_str: str) -> float:
    """Parse ISO timestamp to epoch milliseconds."""
    try:
        dt = datetime.fromisoformat(iso_str)
        return dt.timestamp() * 1000
    except (ValueError, TypeError):
        return 0
