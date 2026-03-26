# Claude Code Monitor

Real-time behavioral monitoring for Claude Code using Varpulis Agent Runtime.

Detects retry storms, error spirals, budget runaway, stuck agent patterns, and **convergent failures** (stale guardrails) as Claude Code works — with a live web dashboard.

## Setup

### 1. Install the monitor

```bash
pip install varpulis-agent-runtime flask
```

### 2. Start the monitor daemon

```bash
python varpulis_monitor.py
```

This starts:
- **Dashboard**: http://localhost:7890/ (auto-refreshes every 2s)
- **Stats API**: http://localhost:7890/stats
- **Health check**: http://localhost:7890/health
- **Proposals API**: http://localhost:7890/api/proposals

### 3. Configure Claude Code hooks

Add this to your `~/.claude/settings.json` (or `.claude/settings.json` in your project):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "jq -c '{hook: \"PreToolUse\", tool_name: .tool_name, tool_input: .tool_input, session_id: .session_id}' | curl -s -X POST http://localhost:7890/event -H 'Content-Type: application/json' -d @- 2>/dev/null || true",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "jq -c '{hook: \"PostToolUse\", tool_name: .tool_name, tool_input: .tool_input, tool_response: .tool_response, session_id: .session_id}' | curl -s -X POST http://localhost:7890/event -H 'Content-Type: application/json' -d @- 2>/dev/null || true",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

This uses Claude Code's command hooks to pipe tool call data through `jq` and `curl` to the monitor.

### 4. Use Claude Code normally

Every tool call (Read, Write, Edit, Bash, Grep, Glob, Agent, etc.) is automatically sent to the Varpulis monitor. Open the dashboard to see events and detections in real-time.

## What it detects

### Per-session patterns

| Pattern | What it means | Default threshold |
|---|---|---|
| **Retry Storm** | Same tool called 4+ times with identical params in 30s | `min_repetitions: 4` |
| **Error Spiral** | 3+ tool failures in 60s | `min_error_count: 3` |
| **Stuck Agent** | 20+ steps without output | `max_steps: 20` |
| **Budget Runaway** | $5+ cost or 500K tokens in 5min | `max_cost_usd: 5.00` |
| **Targeted Failure** | 2+ failures on the same target in 2min | `min_failures: 2` |

### Cross-session convergent failure

| Pattern | What it means | Default threshold |
|---|---|---|
| **Stale Guardrail** | 3+ independent sessions fail on the same target (test, file, endpoint) | `session_threshold: 3` within 1 hour |

When multiple independent sessions — different users, different tasks, completely different code — all fail on the same target, the common denominator is the target, not the code.

**Agents propose amendments they can't ratify. Constitutional, not autocratic.**

## Convergent Failure Detection

The monitor tracks failures across all sessions and correlates them to detect stale guardrails:

```
Session 1 ──ToolResult{fail}──▶ targeted_failure ──┐
Session 2 ──ToolResult{fail}──▶ targeted_failure ──┤
Session 3 ──ToolResult{fail}──▶ targeted_failure ──┤
                                                    ▼
                                  ConvergentFailureTracker
                               (3 sessions × same target)
                                          │
                                          ▼
                               StaleGuardrailProposal
                           ┌──────────┴──────────┐
                           ▼                     ▼
                   .varpulis/proposals/     Dashboard UI
                   (ring-fenced file)      (approve/dismiss)
```

### How target extraction works

When a tool call fails, the monitor extracts the failure target from the error output:

| Framework | Example Error | Extracted Target |
|---|---|---|
| **pytest** | `FAILED tests/test_auth.py::test_login` | `tests/test_auth.py::test_login` |
| **jest** | `FAIL src/__tests__/auth.test.ts` | `src/__tests__/auth.test.ts` |
| **cargo test** | `test tests::test_auth ... FAILED` | `tests::test_auth` |
| **generic** | `Error in tests/test_auth.py:42` | `tests/test_auth.py:42` |

### Proposal files

When the threshold is met, a proposal is written to `.varpulis/proposals/`:

```json
{
  "type": "stale_guardrail",
  "target": "tests/test_auth.py::test_login",
  "evidence": [
    {"session_id": "abc123", "timestamp": "2026-03-26T14:30:00Z", "error_summary": "AssertionError: expected 200 got 401", "task_description": "Add OAuth2 support"},
    {"session_id": "def456", "timestamp": "2026-03-26T15:10:00Z", "error_summary": "AssertionError: expected 200 got 401", "task_description": "Refactor auth middleware"},
    {"session_id": "ghi789", "timestamp": "2026-03-26T16:45:00Z", "error_summary": "AssertionError: expected 200 got 401", "task_description": "Fix login flow"}
  ],
  "session_count": 3,
  "recommendation": "Target 'tests/test_auth.py::test_login' may be outdated — 3 independent sessions failed on it. Consider updating or removing this guardrail.",
  "status": "pending"
}
```

### Reviewing proposals

**Via the dashboard**: Open http://localhost:7890/ and use the Approve/Dismiss buttons in the "Stale Guardrail Proposals" section.

**Via the API**:

```bash
# List all proposals
curl http://localhost:7890/api/proposals

# Approve a proposal
curl -X POST http://localhost:7890/api/proposals/0/resolve \
  -H 'Content-Type: application/json' \
  -d '{"action": "approved"}'

# Dismiss a proposal
curl -X POST http://localhost:7890/api/proposals/0/resolve \
  -H 'Content-Type: application/json' \
  -d '{"action": "dismissed"}'
```

### Persistence

The convergent tracker state is persisted to `.varpulis/convergent_state.json`. Proposals are persisted individually in `.varpulis/proposals/`. Both survive monitor restarts.

## Customizing thresholds

Edit `varpulis_monitor.py` and change the pattern configuration:

```python
PATTERN_CONFIG = [
    Patterns.retry_storm(min_repetitions=3, window_seconds=15),
    Patterns.error_spiral(min_error_count=2, window_seconds=30),
    Patterns.stuck_agent(max_steps_without_output=10),
    Patterns.budget_runaway(max_cost_usd=1.00, max_tokens=100_000),
    Patterns.targeted_failure(min_failures=2, window_seconds=120),
]
```

For convergent failure thresholds, change the tracker initialization:

```python
convergent_tracker = ConvergentFailureTracker(
    session_threshold=3,     # how many distinct sessions before firing
    window_seconds=3600,     # how recent failures must be (1 hour)
)
```

## Dashboard

The web dashboard at http://localhost:7890/ shows:

- **Events processed**: Total tool calls monitored
- **Detections fired**: Patterns that matched
- **Stale guardrail proposals**: Cross-session convergent failures with approve/dismiss buttons (shown when proposals exist)
- **Sessions**: All monitored sessions with event and detection counts
- **Detection log**: Every detection with severity, action, and message
- **Event stream**: Recent tool calls with type and tool name
- **Convergent failure tracking**: Targets being tracked across sessions (shown when records exist)

Auto-refreshes every 2 seconds — no WebSocket needed.

## Feedback Loop (Self-Correcting Agent)

The monitor doesn't just observe — it **feeds back into Claude Code's context**. When a pattern is detected:

1. The detection message and actionable advice are returned in the hook response
2. Claude Code injects this as `additionalContext` into the model's next turn
3. The agent receives guidance like: *"You are repeating the same tool call with identical parameters. Stop and try a different approach."*

For **kill-level detections** (e.g., retry storm exceeding kill threshold), the monitor returns `permissionDecision: "deny"` which blocks the tool call entirely.

This creates a closed loop:

```
Claude Code ──tool call──▶ Varpulis CEP Engine
     ▲                           │
     │                     pattern match?
     │                           │
     └──context injection◀──── advice
```

The agent monitors itself and self-corrects based on CEP pattern detections.

### Advice per pattern

| Pattern | Feedback injected into context |
|---|---|
| **Retry Storm** | "Stop and try a different approach, different parameters, or a different tool." |
| **Error Spiral** | "Pause, analyze the errors, and address the root cause before retrying." |
| **Stuck Agent** | "Summarize your findings and provide an answer to the user." |
| **Budget Runaway** | "Be more concise in your prompts and avoid unnecessary LLM calls." |
| **Targeted Failure** | "You are repeatedly failing on the same target. Stop retrying and report the failing target to the user." |

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Live web dashboard |
| `/event` | POST | Receive hook events from Claude Code |
| `/api/dashboard` | GET | JSON dashboard data (supports `?session=<id>` filter) |
| `/api/proposals` | GET | List all stale guardrail proposals |
| `/api/proposals/<id>/resolve` | POST | Approve or dismiss a proposal (`{"action": "approved"}` or `{"action": "dismissed"}`) |
| `/stats` | GET | Summary statistics |
| `/health` | GET | Health check |

## Architecture

```
Claude Code ──command hooks──▶ Varpulis Monitor (Flask + CEP engine)
     ▲                              │
     │                              ├── /event   (per-session CEP + cross-session correlation)
     │                              ├── /         (web dashboard with proposals)
     │                              ├── /api/proposals (approve/dismiss stale guardrails)
     └──additionalContext◀─────── /stats   (JSON API)
```

The monitor runs the full Varpulis CEP engine (Kleene closure + ZDD) in-process via the native Python extension. Each tool call is converted to a CEP event, fed through the pattern matchers, and detections are returned as actionable context to the agent.

Cross-session convergent failure detection runs in the same process, correlating `targeted_failure` detections across all sessions to identify stale guardrails.
