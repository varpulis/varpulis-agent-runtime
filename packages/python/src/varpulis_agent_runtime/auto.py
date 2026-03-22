"""Auto-patching module for zero-config behavioral guardrails.

Usage:
    import varpulis_agent_runtime
    rt = varpulis_agent_runtime.init()
"""

from __future__ import annotations

import sys
from typing import Any, Callable

from varpulis_agent_runtime.patterns import Patterns
from varpulis_agent_runtime.runtime import VarpulisAgentRuntime

# Sentinel to track whether init() has already run and the global runtime instance.
_global_runtime: VarpulisAgentRuntime | None = None
_patched_frameworks: set[str] = set()

# Default patterns for auto-init: excludes circular_reasoning (false positives in dev).
_AUTO_PATTERNS = [
    Patterns.retry_storm(),
    Patterns.error_spiral(),
    Patterns.stuck_agent(),
    Patterns.budget_runaway(),
]


def _log(msg: str, *, verbose: bool) -> None:
    if verbose:
        print(f"[varpulis] {msg}", file=sys.stderr)


def _patch_langchain(runtime: VarpulisAgentRuntime, *, verbose: bool) -> bool:
    """Attempt to auto-patch LangChain via CallbackManager.configure.

    Returns True if patching succeeded, False if langchain_core is not installed.
    """
    if "langchain" in _patched_frameworks:
        _log("LangChain already patched, skipping", verbose=verbose)
        return True

    try:
        from langchain_core.callbacks import manager as cb_manager  # noqa: F401
    except ImportError:
        _log("langchain_core not found, skipping LangChain patching", verbose=verbose)
        return False

    from varpulis_agent_runtime.integrations.langchain import VarpulisCallbackHandler

    handler = VarpulisCallbackHandler(runtime)

    # CallbackManager.configure is a classmethod. Accessing it on the class
    # returns a bound method (cls is already bound), so we can call it directly.
    _original_configure = cb_manager.CallbackManager.configure

    @classmethod  # type: ignore[misc]
    def _patched_configure(
        cls,
        inheritable_callbacks=None,
        local_callbacks=None,
        verbose=False,
        inheritable_tags=None,
        local_tags=None,
        inheritable_metadata=None,
        local_metadata=None,
    ):
        """Wrapper that injects VarpulisCallbackHandler into every CallbackManager."""
        mgr = _original_configure(
            inheritable_callbacks,
            local_callbacks,
            verbose,
            inheritable_tags,
            local_tags,
            inheritable_metadata,
            local_metadata,
        )
        # Avoid duplicates: check if our handler is already present.
        already_present = any(
            isinstance(h, VarpulisCallbackHandler) for h in mgr.handlers
        )
        if not already_present:
            mgr.add_handler(handler)
        return mgr

    cb_manager.CallbackManager.configure = _patched_configure  # type: ignore[assignment]
    # Store original for potential cleanup
    cb_manager.CallbackManager._varpulis_original_configure = _original_configure  # type: ignore[attr-defined]

    _patched_frameworks.add("langchain")
    _log("LangChain patched successfully", verbose=verbose)
    return True


def _patch_crewai(runtime: VarpulisAgentRuntime, *, verbose: bool) -> bool:
    """Attempt to auto-patch CrewAI via before/after tool call hooks.

    Returns True if patching succeeded, False if crewai is not installed.
    """
    if "crewai" in _patched_frameworks:
        _log("CrewAI already patched, skipping", verbose=verbose)
        return True

    try:
        import crewai  # noqa: F401
    except ImportError:
        _log("crewai not found, skipping CrewAI patching", verbose=verbose)
        return False

    from varpulis_agent_runtime.integrations.crewai import VarpulisCrewAIHook

    hook = VarpulisCrewAIHook(runtime)
    hook.register()

    _patched_frameworks.add("crewai")
    _log("CrewAI patched successfully", verbose=verbose)
    return True


def _patch_openai(runtime: VarpulisAgentRuntime, *, verbose: bool) -> bool:
    """Attempt to auto-patch the OpenAI SDK.

    Returns True if patching succeeded, False if openai is not installed.
    """
    if "openai" in _patched_frameworks:
        _log("OpenAI already patched, skipping", verbose=verbose)
        return True

    try:
        import openai  # noqa: F401
    except ImportError:
        _log("openai not found, skipping OpenAI patching", verbose=verbose)
        return False

    try:
        original_create = openai.resources.chat.completions.Completions.create
    except AttributeError:
        _log("openai.resources.chat.completions.Completions.create not found, skipping", verbose=verbose)
        return False

    import functools

    @functools.wraps(original_create)
    def _patched_create(self, *args: Any, **kwargs: Any) -> Any:
        result = original_create(self, *args, **kwargs)
        # Track the LLM call event
        input_tokens = 0
        output_tokens = 0
        model = kwargs.get("model", "openai")
        if hasattr(result, "usage") and result.usage is not None:
            input_tokens = getattr(result.usage, "prompt_tokens", 0) or 0
            output_tokens = getattr(result.usage, "completion_tokens", 0) or 0
        runtime.observe(
            event_type={
                "type": "LlmCall",
                "model": model,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cost_usd": 0,
            }
        )
        return result

    openai.resources.chat.completions.Completions.create = _patched_create  # type: ignore[assignment]
    openai.resources.chat.completions.Completions._varpulis_original_create = original_create  # type: ignore[attr-defined]

    _patched_frameworks.add("openai")
    _log("OpenAI SDK patched successfully", verbose=verbose)
    return True


def init(
    patterns: list[dict[str, Any]] | None = None,
    cooldown_ms: int = 30_000,
    on_detection: Callable[[dict[str, Any]], None] | None = None,
    verbose: bool = False,
) -> VarpulisAgentRuntime:
    """Auto-patch all detected AI frameworks with Varpulis behavioral guardrails.

    Creates a global ``VarpulisAgentRuntime`` and monkey-patches supported
    frameworks so that every LLM/tool call is automatically observed.

    Args:
        patterns: Optional list of pattern configs. Defaults to retry_storm,
            error_spiral, stuck_agent, and budget_runaway.
        cooldown_ms: Cooldown between detections of the same pattern (ms).
        on_detection: Optional callback invoked on every detection.
        verbose: If True, print detection info to stderr.

    Returns:
        The configured ``VarpulisAgentRuntime`` instance.
    """
    global _global_runtime

    # Idempotent: if already initialised, return existing runtime.
    if _global_runtime is not None:
        _log("Already initialised, returning existing runtime", verbose=verbose)
        return _global_runtime

    if patterns is None:
        patterns = _AUTO_PATTERNS

    runtime = VarpulisAgentRuntime(patterns=patterns, cooldown_ms=cooldown_ms)

    if on_detection is not None:
        runtime.on_detection(on_detection)

    if verbose:
        def _stderr_listener(detection: dict[str, Any]) -> None:
            print(f"[varpulis] DETECTION: {detection}", file=sys.stderr)
        runtime.on_detection(_stderr_listener)

    _global_runtime = runtime

    # Auto-detect and patch frameworks.
    _patch_langchain(runtime, verbose=verbose)
    _patch_crewai(runtime, verbose=verbose)
    _patch_openai(runtime, verbose=verbose)

    _log("init() complete", verbose=verbose)
    return runtime
