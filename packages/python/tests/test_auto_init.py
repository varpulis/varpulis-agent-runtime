"""Tests for varpulis_agent_runtime.init() auto-patching."""

from __future__ import annotations

import varpulis_agent_runtime
from varpulis_agent_runtime import auto


def _reset_auto_state():
    """Reset module-level state so each test starts fresh."""
    auto._global_runtime = None
    auto._patched_frameworks.clear()


def test_init_returns_runtime():
    _reset_auto_state()
    rt = varpulis_agent_runtime.init(verbose=True)
    assert isinstance(rt, varpulis_agent_runtime.VarpulisAgentRuntime)
    assert rt.event_count == 0


def test_init_is_idempotent():
    _reset_auto_state()
    rt1 = varpulis_agent_runtime.init()
    rt2 = varpulis_agent_runtime.init()
    assert rt1 is rt2


def test_init_custom_patterns():
    _reset_auto_state()
    from varpulis_agent_runtime.patterns import Patterns

    rt = varpulis_agent_runtime.init(patterns=[Patterns.retry_storm()])
    assert rt.event_count == 0


def test_init_on_detection_callback():
    _reset_auto_state()
    detections_seen: list[dict] = []
    rt = varpulis_agent_runtime.init(on_detection=detections_seen.append)
    # No events yet, so no detections
    assert len(detections_seen) == 0
    assert rt.event_count == 0


def test_init_skips_missing_frameworks():
    """init() should not raise even when no AI frameworks are installed."""
    _reset_auto_state()
    rt = varpulis_agent_runtime.init(verbose=True)
    assert rt is not None
    assert rt.event_count == 0
