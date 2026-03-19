# Claude Code Monitor

Real-time behavioral monitoring for Claude Code using Varpulis Agent Runtime.

Detects retry storms, circular reasoning, error spirals, budget runaway, and stuck agent patterns as Claude Code works — with a live web dashboard.

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

### 3. Configure Claude Code hooks

Add this to your `~/.claude/settings.json` (or `.claude/settings.json` in your project):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:7890/event",
            "timeout": 3
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:7890/event",
            "timeout": 3
          }
        ]
      }
    ]
  }
}
```

This uses Claude Code's native HTTP hook support — no shell scripts needed.

### 4. Use Claude Code normally

Every tool call (Read, Write, Edit, Bash, Grep, Glob, Agent, etc.) is automatically sent to the Varpulis monitor. Open the dashboard to see events and detections in real-time.

## What it detects

| Pattern | What it means | Default threshold |
|---|---|---|
| **Retry Storm** | Same tool called 4+ times with identical params in 30s | `min_repetitions: 4` |
| **Error Spiral** | 3+ tool failures in 60s | `min_error_count: 3` |
| **Stuck Agent** | 20+ steps without output | `max_steps: 20` |
| **Budget Runaway** | $5+ cost or 500K tokens in 5min | `max_cost_usd: 5.00` |
| **Circular Reasoning** | A→B→A→B tool call cycle | default |

## Customizing thresholds

Edit `varpulis_monitor.py` and change the pattern configuration:

```python
runtime = VarpulisAgentRuntime(
    patterns=[
        Patterns.retry_storm(min_repetitions=3, window_seconds=15),
        Patterns.error_spiral(min_error_count=2, window_seconds=30),
        Patterns.stuck_agent(max_steps_without_output=10),
        Patterns.budget_runaway(max_cost_usd=1.00, max_tokens=100_000),
        Patterns.circular_reasoning(),
    ],
    cooldown_ms=10_000,
)
```

## Dashboard

The web dashboard at http://localhost:7890/ shows:

- **Events processed**: Total tool calls monitored
- **Detections fired**: Patterns that matched
- **Detection log**: Every detection with severity, action, and message
- **Event stream**: Recent tool calls with type and tool name

Auto-refreshes every 2 seconds — no WebSocket needed.

## Architecture

```
Claude Code ──HTTP hooks──▶ Varpulis Monitor (Flask + CEP engine)
                                    │
                                    ├── /event   (receives tool events)
                                    ├── /         (web dashboard)
                                    └── /stats   (JSON API)
```

The monitor runs the full Varpulis CEP engine (Kleene closure + ZDD) in-process via the native Python extension. Each tool call is converted to a CEP event and fed through the pattern matchers.
