"""
Varpulis Monitor Daemon for Claude Code

Runs a tiny HTTP server that receives tool call events from Claude Code hooks
and monitors them through the Varpulis CEP engine in real-time.

Start: cd /tmp/varpulis-test-pypi && source .venv/bin/activate && python varpulis_monitor.py
Stop:  curl http://localhost:7890/stats
"""

import json
import hashlib
import time
from flask import Flask, request, jsonify, render_template_string
from varpulis_agent_runtime import VarpulisAgentRuntime, Patterns

app = Flask(__name__)

# Tuned for Claude Code — circular_reasoning disabled (too many false positives
# from normal Read→Edit→Read→Edit development workflows)
PATTERN_CONFIG = [
    Patterns.retry_storm(min_repetitions=4, window_seconds=30),
    Patterns.error_spiral(min_error_count=3, window_seconds=60),
    Patterns.stuck_agent(max_steps_without_output=20, max_time_without_output_seconds=300),
    Patterns.budget_runaway(max_cost_usd=5.00, max_tokens=500_000, window_seconds=300),
    # circular_reasoning intentionally omitted — Read→Edit and Bash→Edit cycles
    # are normal coding patterns, not agent misbehavior
]

# Per-session runtimes and logs
sessions = {}  # session_id -> { runtime, events, detections }


def get_session(session_id):
    if session_id not in sessions:
        sessions[session_id] = {
            "runtime": VarpulisAgentRuntime(patterns=PATTERN_CONFIG, cooldown_ms=30_000),
            "events": [],
            "detections": [],
            "started": time.strftime("%H:%M:%S"),
            "label": None,  # derived from first meaningful event
        }
    return sessions[session_id]


def derive_session_label(sess, tool_name, tool_input):
    """Try to derive a friendly label from early tool calls."""
    if sess["label"]:
        return
    ti = tool_input if isinstance(tool_input, dict) else {}
    # Use file path from Read/Write/Edit
    path = ti.get("file_path", "") or ti.get("path", "")
    if path:
        # Extract project dir: /home/user/my-project/src/foo.rs → my-project
        parts = path.replace("\\", "/").split("/")
        for i, p in enumerate(parts):
            if p in ("home", "Users", "tmp", "var", ""):
                continue
            if i + 1 < len(parts) and parts[i + 1] not in ("", "home", "Users"):
                sess["label"] = f"{parts[i+1]}" if parts[i] in ("home", "Users") and i + 2 < len(parts) else parts[i]
                return
    # Use command cwd or first word from Bash
    cmd = ti.get("command", "")
    if cmd and tool_name == "Bash":
        sess["label"] = cmd.split()[0][:20] if cmd.split() else None
        return
    # Use glob/grep pattern
    pattern = ti.get("pattern", "")
    if pattern:
        sess["label"] = f"search:{pattern[:20]}"


def _hash(params):
    s = json.dumps(params, sort_keys=True, default=str)
    return int(hashlib.md5(s.encode()).hexdigest()[:8], 16)


@app.route("/event", methods=["POST"])
def receive_event():
    """Receives hook events from Claude Code (PreToolUse / PostToolUse HTTP hooks)."""
    data = request.json or {}
    tool_name = data.get("tool_name", "unknown")
    tool_input = data.get("tool_input", {})
    tool_response = data.get("tool_response", {})
    session_id = data.get("session_id", "")

    ts = int(time.time() * 1000)
    now = time.strftime("%H:%M:%S")
    sid = session_id[:8] if session_id else "unknown"

    sess = get_session(session_id)
    runtime = sess["runtime"]

    # Determine if this is pre or post based on presence of tool_response
    is_post = "tool_response" in data and data["tool_response"] is not None

    derive_session_label(sess, tool_name, tool_input)

    if not is_post:
        event_entry = {"time": now, "type": "ToolCall", "tool": tool_name, "session": sid, "input_preview": str(tool_input)[:100]}
        sess["events"].append(event_entry)
        dets = runtime.observe(
            timestamp=ts,
            event_type={
                "type": "ToolCall",
                "name": tool_name,
                "params_hash": _hash(tool_input),
                "duration_ms": 0,
            },
        )
    else:
        is_error = not tool_response.get("success", True) if isinstance(tool_response, dict) else False
        event_entry = {"time": now, "type": "ToolResult", "tool": tool_name, "session": sid, "success": not is_error}
        sess["events"].append(event_entry)
        dets = runtime.observe(
            timestamp=ts,
            event_type={
                "type": "ToolResult",
                "name": tool_name,
                "success": not is_error,
                "error": str(tool_response.get("error", "")) if is_error else None,
            },
        )

    for d in dets:
        entry = {"time": now, "session": sid, **d}
        sess["detections"].append(entry)
        print(f"\033[91m  VARPULIS [{sid}] [{d['severity'].upper()}] {d['pattern_name']}: {d['message']}\033[0m")

    if not dets:
        return jsonify({"detections": 0})

    # Build feedback for Claude Code
    response = {}
    feedback_lines = []
    for d in dets:
        feedback_lines.append(f"[{d['severity'].upper()}] {d['pattern_name']}: {d['message']}")

    advice = PATTERN_ADVICE.get(dets[0]["pattern_name"], "Consider changing your approach.")
    feedback_lines.append(f"Suggestion: {advice}")
    context = "VARPULIS CEP DETECTION: " + " | ".join(feedback_lines)

    if not is_post:
        response["hookSpecificOutput"] = {
            "hookEventName": "PreToolUse",
            "additionalContext": context,
        }
        if any(d.get("action") == "kill" for d in dets):
            response["hookSpecificOutput"]["permissionDecision"] = "deny"
            response["hookSpecificOutput"]["permissionDecisionReason"] = dets[0]["message"]
    if is_post:
        response["hookSpecificOutput"] = {
            "hookEventName": "PostToolUse",
            "additionalContext": context,
        }

    return jsonify(response)


PATTERN_ADVICE = {
    "retry_storm": "You are repeating the same tool call with identical parameters. Stop and try a different approach, different parameters, or a different tool.",
    "error_spiral": "Multiple tool calls are failing. Pause, analyze the errors, and address the root cause before retrying.",
    "stuck_agent": "You have been running many steps without producing output. Summarize your findings and provide an answer to the user.",
    "budget_runaway": "Token/cost usage is high. Be more concise in your prompts and avoid unnecessary LLM calls.",
    "circular_reasoning": "You are alternating between the same tools in a loop. Break the cycle by trying a completely different approach.",
}


DASHBOARD_HTML = """
<!DOCTYPE html>
<html>
<head>
<title>Varpulis Monitor — Claude Code</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #0f0f23; color: #cdd6f4; padding: 1.5rem; }
  h1 { font-size: 1.4rem; margin-bottom: 0.5rem; color: #89b4fa; }
  .subtitle { color: #6c7086; margin-bottom: 1rem; font-size: 0.9rem; }
  .filters { margin-bottom: 1.5rem; display: flex; gap: 1rem; align-items: center; }
  .filters label { color: #6c7086; font-size: 0.85rem; }
  .filters select { background: #1e1e2e; color: #cdd6f4; border: 1px solid #313244; border-radius: 4px; padding: 4px 8px; font-size: 0.85rem; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; margin-bottom: 1.5rem; }
  .card { background: #1e1e2e; border-radius: 8px; padding: 1rem; border: 1px solid #313244; }
  .card h2 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: #6c7086; margin-bottom: 0.75rem; }
  .stat { font-size: 2rem; font-weight: 700; }
  .stat.green { color: #a6e3a1; }
  .stat.yellow { color: #f9e2af; }
  .stat.red { color: #f38ba8; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th { text-align: left; padding: 0.5rem; color: #6c7086; border-bottom: 1px solid #313244; font-weight: 500; }
  td { padding: 0.5rem; border-bottom: 1px solid #1e1e2e; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
  .badge.warning { background: #f9e2af22; color: #f9e2af; }
  .badge.error { background: #f38ba822; color: #f38ba8; }
  .badge.critical { background: #f38ba844; color: #f38ba8; }
  .badge.info { background: #89b4fa22; color: #89b4fa; }
  .badge.alert { background: #a6e3a122; color: #a6e3a1; }
  .badge.kill { background: #f38ba844; color: #f38ba8; }
  .badge.ToolCall { background: #89b4fa22; color: #89b4fa; }
  .badge.ToolResult { background: #a6e3a122; color: #a6e3a1; }
  .full { grid-column: 1 / -1; }
  .scroll { max-height: 400px; overflow-y: auto; }
  #status { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #a6e3a1; margin-right: 6px; }
  .session-btn { cursor: pointer; color: #89b4fa; text-decoration: underline; background: none; border: none; font: inherit; }
</style>
</head>
<body>
  <h1><span id="status"></span>Varpulis Monitor — Claude Code</h1>
  <p class="subtitle">Real-time CEP-powered behavioral monitoring (auto-refreshes every 2s)</p>

  <div class="filters">
    <label>Filter by session:</label>
    <select id="sessionFilter" onchange="refresh()">
      <option value="all">All sessions</option>
    </select>
  </div>

  <div class="grid">
    <div class="card">
      <h2>Events Processed</h2>
      <div class="stat green" id="eventCount">0</div>
    </div>
    <div class="card">
      <h2>Detections Fired</h2>
      <div class="stat" id="detectionCount">0</div>
    </div>
  </div>

  <div class="grid">
    <div class="card full">
      <h2>Sessions</h2>
      <table>
        <thead><tr><th>Session ID</th><th>Label</th><th>Started</th><th>Events</th><th>Detections</th><th></th></tr></thead>
        <tbody id="sessions"></tbody>
      </table>
    </div>
  </div>

  <div class="grid">
    <div class="card full">
      <h2>Detections</h2>
      <div class="scroll">
        <table>
          <thead><tr><th>Time</th><th>Session</th><th>Pattern</th><th>Severity</th><th>Action</th><th>Message</th></tr></thead>
          <tbody id="detections"></tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="grid">
    <div class="card full">
      <h2>Recent Events</h2>
      <div class="scroll">
        <table>
          <thead><tr><th>Time</th><th>Session</th><th>Type</th><th>Tool</th><th>Details</th></tr></thead>
          <tbody id="events"></tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    let lastSessionList = '';

    function filterSession(sid) {
      document.getElementById('sessionFilter').value = sid;
      refresh();
    }

    async function refresh() {
      try {
        const filter = document.getElementById('sessionFilter').value;
        const url = filter === 'all' ? '/api/dashboard' : `/api/dashboard?session=${filter}`;
        const res = await fetch(url);
        const data = await res.json();

        document.getElementById('eventCount').textContent = data.event_count;
        const dc = document.getElementById('detectionCount');
        dc.textContent = data.detection_count;
        dc.className = 'stat ' + (data.detection_count > 0 ? 'red' : 'green');

        // Update session filter dropdown (preserve selection)
        const newList = JSON.stringify(data.sessions.map(s => s.id));
        if (newList !== lastSessionList) {
          lastSessionList = newList;
          const sel = document.getElementById('sessionFilter');
          const cur = sel.value;
          sel.innerHTML = '<option value="all">All sessions</option>' +
            data.sessions.map(s => `<option value="${s.id}">${s.label || s.id} (${s.events} events)</option>`).join('');
          sel.value = cur;
        }

        const sTbody = document.getElementById('sessions');
        sTbody.innerHTML = (data.sessions || []).map(s =>
          `<tr><td><code>${s.id}</code></td><td>${s.label || ''}</td><td>${s.started}</td><td>${s.events}</td><td class="${s.detections > 0 ? 'stat red' : ''}" style="font-size:inherit">${s.detections}</td><td><button class="session-btn" onclick="filterSession('${s.id}')">filter</button></td></tr>`
        ).join('');

        const dTbody = document.getElementById('detections');
        dTbody.innerHTML = data.detections.slice().reverse().map(d =>
          `<tr><td>${d.time}</td><td><code>${d.session || '?'}</code></td><td>${d.pattern_name}</td><td><span class="badge ${d.severity}">${d.severity}</span></td><td><span class="badge ${d.action}">${d.action}</span></td><td>${d.message}</td></tr>`
        ).join('');

        const eTbody = document.getElementById('events');
        eTbody.innerHTML = data.events.slice(-50).reverse().map(e =>
          `<tr><td>${e.time}</td><td><code>${e.session || '?'}</code></td><td><span class="badge ${e.type}">${e.type}</span></td><td>${e.tool}</td><td>${e.input_preview || (e.success !== undefined ? (e.success ? 'ok' : 'error') : '')}</td></tr>`
        ).join('');
      } catch(e) {}
    }
    refresh();
    setInterval(refresh, 2000);
  </script>
</body>
</html>
"""


@app.route("/")
def dashboard():
    return render_template_string(DASHBOARD_HTML)


@app.route("/api/dashboard")
def api_dashboard():
    session_filter = request.args.get("session", "all")

    all_events = []
    all_detections = []
    total_event_count = 0
    session_summaries = []

    for sid, sess in sessions.items():
        short_id = sid[:8] if sid else "unknown"
        session_summaries.append({
            "id": short_id,
            "label": sess.get("label") or short_id,
            "started": sess["started"],
            "events": sess["runtime"].event_count,
            "detections": len(sess["detections"]),
        })

        if session_filter == "all" or session_filter == short_id:
            all_events.extend(sess["events"])
            all_detections.extend(sess["detections"])
            total_event_count += sess["runtime"].event_count

    all_events.sort(key=lambda e: e["time"])
    all_detections.sort(key=lambda e: e["time"])

    return jsonify({
        "event_count": total_event_count,
        "detection_count": len(all_detections),
        "detections": all_detections[-50:],
        "events": all_events[-50:],
        "sessions": session_summaries,
    })


@app.route("/stats", methods=["GET"])
def stats():
    total_events = sum(s["runtime"].event_count for s in sessions.values())
    all_dets = [d for s in sessions.values() for d in s["detections"]]
    return jsonify({
        "event_count": total_events,
        "sessions": len(sessions),
        "detections": len(all_dets),
        "recent": all_dets[-10:],
    })


@app.route("/health", methods=["GET"])
def health():
    total_events = sum(s["runtime"].event_count for s in sessions.values())
    return jsonify({"status": "ok", "event_count": total_events, "sessions": len(sessions)})


if __name__ == "__main__":
    print("Varpulis Monitor running on http://localhost:7890")
    print("  Dashboard: http://localhost:7890/")
    print("  API:       http://localhost:7890/stats")
    print()
    app.run(host="127.0.0.1", port=7890, debug=False)
