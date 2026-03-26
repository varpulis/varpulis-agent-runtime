"""Learn tier: CLAUDE.md rule generation, deduplication, and application.

All functions are pure — no filesystem access. The caller provides
CLAUDE.md content as a string and receives the mutated string back.
"""

from __future__ import annotations

import re
from typing import Any

from varpulis_agent_runtime.history import DetectionHistory


class LearnProposal:
    """A proposed mutation to CLAUDE.md."""

    __slots__ = ("pattern_name", "rule_text", "section", "severity", "dedup_key")

    def __init__(
        self,
        pattern_name: str,
        rule_text: str,
        section: str,
        severity: str,
        dedup_key: str,
    ):
        self.pattern_name = pattern_name
        self.rule_text = rule_text
        self.section = section
        self.severity = severity  # NEVER | ALWAYS | PREFER
        self.dedup_key = dedup_key


# ---------------------------------------------------------------------------
# Rule templates per pattern
# ---------------------------------------------------------------------------

_STOP_WORDS = frozenset(
    "the a an to do not and or if in of is it be as by on at for with "
    "you your this that from are was has have".split()
)


def _intent_stall(ctx: dict[str, Any]) -> LearnProposal:
    if ctx.get("tool_name") == "bash":
        text = "When a bash command is needed, emit the tool call immediately. Do not narrate the command before running it."
    else:
        text = "ALWAYS call tools directly. NEVER describe what you will do before doing it — emit the tool_use block immediately."
    return LearnProposal("IntentStall", text, "Behavioral Rules", "ALWAYS", "intent_stall_no_narrate")


def _compaction_spiral(_ctx: dict[str, Any]) -> LearnProposal:
    return LearnProposal(
        "CompactionSpiral",
        "Keep CLAUDE.md concise (under 8KB). If context is tight, split the task into smaller sessions rather than relying on compaction.",
        "Behavioral Rules", "PREFER", "compaction_spiral_context",
    )


def _context_starvation(_ctx: dict[str, Any]) -> LearnProposal:
    return LearnProposal(
        "ContextStarvation",
        "System context is consuming most of the context window. Reduce CLAUDE.md size or MCP server count.",
        "Behavioral Rules", "PREFER", "context_starvation_reduce",
    )


def _retry_storm(ctx: dict[str, Any]) -> LearnProposal:
    tool = ctx.get("tool_name")
    if tool:
        text = f"If {tool} fails twice with the same parameters, stop retrying and report the error to the user."
    else:
        text = "If a tool call fails twice with identical parameters, stop retrying and report the error to the user."
    return LearnProposal("retry_storm", text, "Behavioral Rules", "ALWAYS", f"retry_storm_{tool or 'generic'}")


def _error_spiral(_ctx: dict[str, Any]) -> LearnProposal:
    return LearnProposal(
        "error_spiral",
        "When multiple tool calls fail in succession, stop and analyze the root cause before retrying. Do not attempt more than 3 failing calls without changing approach.",
        "Behavioral Rules", "ALWAYS", "error_spiral_stop_analyze",
    )


def _circular_reasoning(_ctx: dict[str, Any]) -> LearnProposal:
    return LearnProposal(
        "circular_reasoning",
        "When searching for information: search once, read the top result, extract what you need, move on. Do not re-search the same query or alternate between the same tools without synthesizing.",
        "Behavioral Rules", "ALWAYS", "circular_reasoning_search_once",
    )


def _stuck_agent(_ctx: dict[str, Any]) -> LearnProposal:
    return LearnProposal(
        "stuck_agent",
        "If you have taken more than 10 steps without producing output, stop and summarize your findings for the user.",
        "Behavioral Rules", "ALWAYS", "stuck_agent_summarize",
    )


def _budget_runaway(_ctx: dict[str, Any]) -> LearnProposal:
    return LearnProposal(
        "budget_runaway",
        "Be concise in tool calls and avoid unnecessary LLM round-trips. Prefer batch operations over sequential ones.",
        "Behavioral Rules", "PREFER", "budget_runaway_concise",
    )


def _git_push_violation(ctx: dict[str, Any]) -> LearnProposal:
    branch = ctx.get("branch_name")
    if branch:
        text = f"NEVER push directly to the {branch} branch. Always use a feature branch and create a PR."
    else:
        text = "NEVER push directly to main, master, or production branches. Always use a feature branch and create a PR."
    return LearnProposal("GitPushViolation", text, "Safety Rules", "NEVER", f"git_push_violation_{branch or 'protected'}")


def _config_overwrite_violation(ctx: dict[str, Any]) -> LearnProposal:
    path = ctx.get("path_pattern")
    if path:
        text = f"NEVER write to {path} without explicit user approval."
    else:
        text = "NEVER write to production config files (.env, prod.*, production.*) without explicit user approval."
    return LearnProposal("ConfigOverwriteViolation", text, "Safety Rules", "NEVER", f"config_overwrite_{path or 'prod_config'}")


def _targeted_failure(ctx: dict[str, Any]) -> LearnProposal:
    tool = ctx.get("tool_name")
    if tool:
        text = f"When {tool} fails repeatedly on the same target, stop and report the failing target to the user instead of retrying."
    else:
        text = "When a tool fails repeatedly on the same target (test, file, or endpoint), stop and report the failing target to the user instead of retrying."
    return LearnProposal("targeted_failure", text, "Behavioral Rules", "ALWAYS", f"targeted_failure_{tool or 'generic'}")


_TEMPLATES: dict[str, Any] = {
    "IntentStall": _intent_stall,
    "CompactionSpiral": _compaction_spiral,
    "ContextStarvation": _context_starvation,
    "retry_storm": _retry_storm,
    "error_spiral": _error_spiral,
    "circular_reasoning": _circular_reasoning,
    "stuck_agent": _stuck_agent,
    "budget_runaway": _budget_runaway,
    "GitPushViolation": _git_push_violation,
    "ConfigOverwriteViolation": _config_overwrite_violation,
    "targeted_failure": _targeted_failure,
}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def propose_rule(
    detection: dict[str, Any],
    context: dict[str, Any] | None = None,
) -> LearnProposal | None:
    """Generate a rule proposal from a detection dict."""
    pattern = detection.get("pattern_name", "")
    template = _TEMPLATES.get(pattern)
    if not template:
        return None
    ctx: dict[str, Any] = {}
    details = detection.get("details", {})
    ctx["tool_name"] = (context or {}).get("tool_name") or details.get("tool_name")
    ctx["branch_name"] = (context or {}).get("branch_name") or details.get("branch_name")
    ctx["path_pattern"] = (context or {}).get("path_pattern") or details.get("path_pattern")
    return template(ctx)


def is_duplicate(proposal: LearnProposal, content: str) -> bool:
    """Check if a proposed rule already exists in CLAUDE.md content."""
    marker = f"<!-- varpulis:{proposal.dedup_key} -->"
    if marker in content:
        return True
    # Fuzzy match
    proposal_words = _extract_key_words(proposal.rule_text)
    for line in content.split("\n"):
        line_words = _extract_key_words(line)
        if len(line_words) < 3:
            continue
        overlap = proposal_words & line_words
        similarity = len(overlap) / min(len(proposal_words), len(line_words))
        if similarity >= 0.6:
            return True
    return False


def apply_rule(proposal: LearnProposal, content: str) -> str:
    """Apply a rule proposal to CLAUDE.md content. Returns new content."""
    marker = f"<!-- varpulis:{proposal.dedup_key} -->"
    # Reinforce if marker already exists
    reinforce_re = re.compile(re.escape(marker) + r"(?: ×(\d+))?")
    match = reinforce_re.search(content)
    if match:
        count = int(match.group(1) or "1") + 1
        return reinforce_re.sub(f"{marker} ×{count}", content, count=1)

    rule_line = f"- {proposal.rule_text} {marker}"
    section_heading = f"## {proposal.section}"
    idx = content.find(section_heading)
    if idx != -1:
        after = idx + len(section_heading)
        next_section = content.find("\n## ", after)
        insert_at = next_section if next_section != -1 else len(content)
        before = content[:insert_at].rstrip()
        rest = content[insert_at:]
        return f"{before}\n{rule_line}\n{rest}"
    trimmed = content.rstrip()
    return f"{trimmed}\n\n{section_heading}\n\n{rule_line}\n"


def evaluate(
    detection: dict[str, Any],
    history: DetectionHistory,
    session_id: str,
    claude_md_content: str,
    *,
    threshold: int = 3,
    context: dict[str, Any] | None = None,
    forced_patterns: list[str] | None = None,
) -> tuple[LearnProposal, str] | None:
    """Full Learn lifecycle: check history, propose, dedup, apply.

    Returns (proposal, new_content) if a rule should be applied, else None.
    """
    if forced_patterns is None:
        forced_patterns = ["GitPushViolation", "ConfigOverwriteViolation"]

    pattern_name = detection.get("pattern_name", "")
    history.record(pattern_name, session_id)

    forced = pattern_name in forced_patterns
    if not forced and not history.should_learn(pattern_name, threshold):
        return None

    proposal = propose_rule(detection, context)
    if proposal is None:
        return None

    if is_duplicate(proposal, claude_md_content):
        history.mark_learned(pattern_name)
        return None

    new_content = apply_rule(proposal, claude_md_content)
    history.mark_learned(pattern_name)
    return proposal, new_content


def _extract_key_words(text: str) -> set[str]:
    words = set(re.findall(r"[a-z]{3,}", text.lower()))
    return words - _STOP_WORDS
